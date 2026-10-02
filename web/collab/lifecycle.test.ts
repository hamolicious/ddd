import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { mintUlid } from "../harness/src/core.js";
import { HttpError } from "../harness/src/rest.js";
import { Peer } from "./peer.js";
import { BOB, converged, eachExactlyOnce, serverText, sleep, world, type World } from "./world.js";

let w: World;
beforeAll(async () => {
  w = await world(8133);
});
afterAll(() => w?.close());

describe("notes made on a device (PROTOCOL.md §3.8)", () => {
  test("made offline, edited more, then shared: the text never doubles", async () => {
    const alice = await w.device("alice");
    alice.offline();
    const id = await alice.create("# Made on a train\n\nfirst thought\n");
    alice.append(id, "second thought\n");
    await alice.online();
    expect(await serverText(w.rest, id)).toBe("# Made on a train\n\nfirst thought\nsecond thought\n");

    const bob = await w.device("bob", BOB);
    await bob.open(id);
    alice.append(id, "third thought\n");
    bob.insertAfter(id, "first thought", " (bob agrees)");
    const text = await converged(w.rest, id, [alice, bob]);
    eachExactlyOnce(text, ["# Made on a train", "first thought", "second thought", "third thought", "(bob agrees)"]);
  });

  test("made offline and the tab closed before it was ever sent", async () => {
    const alice = await w.device("alice");
    alice.offline();
    const id = await alice.create("# Unsent\n\nonly on this device\n");
    const saved = alice.persist();
    await alice.close();
    const again = Peer.revive("alice-again", alice.baseUrl, alice.token, saved);
    again.append(id, "and a bit more\n");
    await again.online();
    expect(await converged(w.rest, id, [again])).toBe("# Unsent\n\nonly on this device\nand a bit more\n");
    await again.close();
  });

  test("a create whose reply was lost is sent again and recognised as ours", async () => {
    const alice = await w.device("alice");
    const id = await alice.create("# Lost reply\n\n");
    alice.loseCreateReply(id);
    await alice.flushCreates();
    expect(alice.forks.size).toBe(0);
    alice.append(id, "after the retry\n");
    expect(await converged(w.rest, id, [alice])).toBe("# Lost reply\n\nafter the retry\n");
  });

  test("two devices mint the same id offline: the first keeps it, the second becomes a new note", async () => {
    const id = mintUlid(Math.random, Date.now());
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    alice.offline();
    bob.offline();
    await alice.create("# Alice's note\n", id);
    await bob.create("# Bob's note\n", id);
    await alice.online();
    await bob.online();

    const moved = bob.forks.get(id);
    expect(moved).toBeDefined();
    expect(await serverText(w.rest, id)).toBe("# Alice's note\n");
    expect(await serverText(w.rest, moved!)).toBe("# Bob's note\n");
  });

  test("a note made offline is edited by its maker while others are already editing it", async () => {
    const alice = await w.device("alice");
    const id = await alice.create("# Handoff\n\n");
    const bob = await w.device("bob", BOB);
    await bob.open(id);
    alice.offline();
    for (let n = 0; n < 10; n += 1) {
      alice.append(id, `a${n}\n`);
      bob.append(id, `b${n}\n`);
    }
    await alice.online();
    eachExactlyOnce(
      await converged(w.rest, id, [alice, bob]),
      Array.from({ length: 10 }, (_, n) => [`a${n}\n`, `b${n}\n`]).flat(),
    );
  });
});

describe("Trash (SYNC-DECISIONS §3)", () => {
  test("trashed elsewhere while edited offline: the edits are kept, in Trash, and restorable", async () => {
    const id = await w.note("# Doomed\n\nbody\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    alice.offline();
    alice.append(id, "written offline\n");
    await bob.rest.request("DELETE", `/api/documents/${id}`);
    await alice.online();

    expect(await converged(w.rest, id, [alice])).toContain("written offline\n");
    expect((await w.rest.getDocument(id)).deleted).toBe(true);
    await bob.rest.request("POST", `/api/documents/${id}/restore`);
    const restored = await w.rest.getDocument(id);
    expect(restored.deleted).toBe(false);
    expect(restored.content).toContain("written offline\n");
  });

  test("trashed while someone is live in it: their typing still lands", async () => {
    const id = await w.note("# Live trash\n\n");
    const alice = await w.device("alice");
    await alice.open(id);
    await Promise.all([
      alice.type(id, alice.text(id).length, "still typing", 10),
      (async () => {
        await sleep(40);
        await w.rest.request("DELETE", `/api/documents/${id}`);
      })(),
    ]);
    expect(await converged(w.rest, id, [alice])).toBe("# Live trash\n\nstill typing");
  });
});

describe("deleted for good (SYNC-DECISIONS §4)", () => {
  test(
    "purged while a device held unsent edits: the device keeps them and can save them as a new note",
    async (context) => {
      if (!w.server.owned) context.skip();
      const id = await w.note("# Purge me\n\n");
      const alice = await w.device("alice");
      await alice.open(id);
      alice.offline();
      alice.append(id, "unsent\n");
      await w.rest.request("DELETE", `/api/documents/${id}`);
      await w.server.restart({ TRASH_RETENTION_DAYS: "0" });
      await w.server.restart();

      await alice.online();
      await expect.poll(() => alice.docErrors(id).map((error) => error.code)).toContain("gone");
      expect(alice.text(id)).toBe("# Purge me\n\nunsent\n");
      const reuse = await w.rest
        .request("POST", "/api/documents", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, content: "again" }),
        })
        .then((response) => response.status)
        .catch((error: unknown) => (error instanceof HttpError ? error.status : -1));
      expect(reuse).toBeGreaterThanOrEqual(400);
      const saved = await alice.create(alice.text(id));
      expect(await serverText(w.rest, saved)).toBe("# Purge me\n\nunsent\n");
    },
  );
});

describe("the server goes away", () => {
  const owned = () => w.server.owned;

  test("restarted mid-edit: everyone reconnects and nothing typed meanwhile is lost", async (context) => {
    if (!owned()) context.skip();
    const id = await w.note("# Restart\n\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);
    alice.append(id, "before\n");
    await converged(w.rest, id, [alice, bob]);

    await w.server.stop();
    alice.append(id, "while down (alice)\n");
    bob.append(id, "while down (bob)\n");
    await w.server.start();
    alice.append(id, "after\n");

    const text = await converged(w.rest, id, [alice, bob], 30_000);
    eachExactlyOnce(text, ["before\n", "while down (alice)\n", "while down (bob)\n", "after\n"]);
  });

  test("restarted while one device was offline: it comes back to a new server process", async (context) => {
    if (!owned()) context.skip();
    const id = await w.note("# Restart offline\n\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);
    alice.offline();
    alice.append(id, "offline across a restart\n");
    bob.append(id, "online before the restart\n");
    await converged(w.rest, id, [bob]);
    await w.server.restart();
    bob.append(id, "online after the restart\n");
    await alice.online();
    eachExactlyOnce(await converged(w.rest, id, [alice, bob], 30_000), [
      "offline across a restart\n",
      "online before the restart\n",
      "online after the restart\n",
    ]);
  });
});
