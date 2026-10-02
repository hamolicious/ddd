import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { spliceFrontmatterValue } from "../harness/src/ops.js";
import { ALICE, BOB, converged, eachExactlyOnce, serverText, sleep, world, type World } from "./world.js";

let w: World;
beforeAll(async () => {
  w = await world(8131);
});
afterAll(() => w?.close());

describe("two people, one note, at the same time", () => {
  test("typing at the same spot: both words survive, neither is split", async () => {
    const id = await w.note("# Race\n\n[]\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);
    const at = alice.text(id).indexOf("[]") + 1;
    await Promise.all([alice.type(id, at, "alpha", 5), bob.type(id, at, "bravo", 5)]);
    const text = await converged(w.rest, id, [alice, bob]);
    expect(text).toMatch(/\[(alphabravo|bravoalpha)\]/);
  });

  test("edits that cross in flight on a slow link converge", async () => {
    const id = await w.note("# Slow\n\none\ntwo\nthree\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);
    alice.latency(250);
    bob.latency(250);
    for (let round = 0; round < 10; round += 1) {
      alice.insertAfter(id, "one", ` a${round}`);
      bob.insertAfter(id, "three", ` b${round}`);
      await sleep(30);
    }
    alice.replace(id, "two", "TWO");
    bob.replace(id, "two", "deux");
    alice.latency(0);
    bob.latency(0);
    const text = await converged(w.rest, id, [alice, bob]);
    expect(text).toMatch(/\n(TWOdeux|deuxTWO)\n/);
    eachExactlyOnce(text, Array.from({ length: 10 }, (_, i) => [` a${i}`, ` b${i}`]).flat());
  });

  test("both delete the same words: deleted once, nothing around them lost", async () => {
    const id = await w.note("# Delete\n\nkeep DROP ME keep too\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);
    alice.latency(200);
    bob.latency(200);
    alice.replace(id, "DROP ME ", "");
    bob.replace(id, "DROP ME ", "");
    alice.latency(0);
    bob.latency(0);
    expect(await converged(w.rest, id, [alice, bob])).toBe("# Delete\n\nkeep keep too\n");
  });

  test("one deletes a paragraph while the other types inside it: the new words are kept", async () => {
    const id = await w.note("# Para\n\nfirst\n\nthe doomed paragraph\n\nlast\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);
    alice.latency(200);
    bob.latency(200);
    alice.replace(id, "the doomed paragraph\n\n", "");
    bob.insertAfter(id, "the doomed", " (but my note)");
    alice.latency(0);
    bob.latency(0);
    const text = await converged(w.rest, id, [alice, bob]);
    expect(text).toContain(" (but my note)");
    expect(text).not.toContain("paragraph");
    expect(text).toMatch(/^# Para\n\nfirst\n\n[\s\S]*last\n$/);
  });

  test("frontmatter: different keys both apply, the same key settles on one value", async () => {
    const id = await w.note("---\nstatus: open\nowner: nobody\npriority: 1\n---\n\n# FM\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);
    alice.latency(200);
    bob.latency(200);
    spliceFrontmatterValue(alice.yText(id), "status", "done");
    spliceFrontmatterValue(bob.yText(id), "owner", "bob");
    spliceFrontmatterValue(alice.yText(id), "priority", "2");
    spliceFrontmatterValue(bob.yText(id), "priority", "3");
    alice.latency(0);
    bob.latency(0);
    await converged(w.rest, id, [alice, bob]);
    await expect
      .poll(async () => (await w.rest.getDocument(id)).fm, { timeout: 5_000 })
      .toMatchObject({ status: "done", owner: "bob" });
    const doc = await w.rest.getDocument(id);
    expect(doc.fm_parse_error).toBe(false);
    expect(String(doc.fm["priority"])).toMatch(/^(2|3|23|32)$/);
  });
});

describe("many devices", () => {
  test("four devices, two people, a burst each: every keystroke lands exactly once", async () => {
    const id = await w.note("# Burst\n\n");
    const devices = await Promise.all([
      w.device("alice-laptop", ALICE),
      w.device("alice-phone", ALICE),
      w.device("bob-laptop", BOB),
      w.device("bob-phone", BOB),
    ]);
    for (const device of devices) await device.open(id);
    const tokens: string[] = [];
    await Promise.all(
      devices.map(async (device, index) => {
        for (let n = 0; n < 40; n += 1) {
          const token = `<${index}.${n}>`;
          tokens.push(token);
          const text = device.text(id);
          const starts = [...text.matchAll(/\n/g)].map((match) => match.index + 1);
          device.insert(id, starts[Math.floor(Math.random() * starts.length)] ?? text.length, `${token}\n`);
          if (n % 7 === 0) await sleep(10);
        }
      }),
    );
    const text = await converged(w.rest, id, devices);
    eachExactlyOnce(text, tokens);
  });

  test("a device that opens the note late sees everything so far", async () => {
    const id = await w.note("# Late\n\n");
    const alice = await w.device("alice");
    await alice.open(id);
    for (let n = 0; n < 50; n += 1) alice.append(id, `line ${n}\n`);
    await converged(w.rest, id, [alice]);
    const bob = await w.device("bob", BOB);
    await bob.open(id);
    expect(bob.text(id)).toBe(alice.text(id));
    bob.append(id, "bob was here\n");
    await converged(w.rest, id, [alice, bob]);
  });

  test("a change saved over REST reaches every open editor without a resubscribe", async () => {
    const id = await w.note("# REST\n\nbefore\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);
    bob.append(id, "typed\n");
    await converged(w.rest, id, [alice, bob]);
    await w.rest.replaceDocument(id, "# REST\n\nafter\ntyped\n");
    expect(await converged(w.rest, id, [alice, bob])).toBe("# REST\n\nafter\ntyped\n");
  });

  test("the same account on two devices behaves like two people", async () => {
    const id = await w.note("# Me twice\n\n");
    const laptop = await w.device("laptop", ALICE);
    const phone = await w.device("phone", ALICE);
    await laptop.open(id);
    await phone.open(id);
    await Promise.all([laptop.type(id, 12, "from laptop ", 2), phone.type(id, 12, "from phone ", 2)]);
    const text = await converged(w.rest, id, [laptop, phone]);
    eachExactlyOnce(text, ["from laptop ", "from phone "]);
    expect(await serverText(w.rest, id)).toBe(text);
  });
});
