/**
 * Online and offline mixed: devices that drop off, keep editing, come back — alone,
 * together, over and over, and with frames still in flight when the wire goes.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { Peer } from "./peer.js";
import { ALICE, BOB, converged, eachExactlyOnce, serverText, sleep, world, type World } from "./world.js";

let w: World;
beforeAll(async () => {
  w = await world(8132);
});
afterAll(() => w?.close());

describe("one offline, one online", () => {
  test("both people's edits survive the reconnect, on both devices", async () => {
    const id = await w.note("# Mixed\n\nmorning\n\nevening\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);

    alice.offline();
    alice.insertAfter(id, "morning", ": run");
    bob.insertAfter(id, "evening", ": read");
    await expect.poll(() => serverText(w.rest, id)).toContain("evening: read");
    expect(alice.text(id)).not.toContain("read");

    await alice.online();
    expect(await converged(w.rest, id, [alice, bob])).toBe("# Mixed\n\nmorning: run\n\nevening: read\n");
  });

  test("offline, one deletes everything the other is still adding to", async () => {
    const id = await w.note("# Wipe\n\nold one\nold two\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);

    alice.offline();
    alice.delete(id, 0, alice.text(id).length);
    alice.append(id, "# Fresh start\n");
    bob.insertAfter(id, "old one", " (bob's addition)");
    bob.append(id, "bob's new line\n");
    await alice.online();

    const text = await converged(w.rest, id, [alice, bob]);
    // Alice deleted what she saw; what Bob added meanwhile she never saw, so it stays.
    expect(text).not.toContain("old one");
    expect(text).not.toContain("old two");
    eachExactlyOnce(text, ["# Fresh start\n", " (bob's addition)", "bob's new line\n"]);
  });

  test("hundreds of offline keystrokes go up in one reconnect", async () => {
    const id = await w.note("# Long flight\n\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);

    alice.offline();
    await alice.type(id, alice.text(id).length, "written on a plane. ".repeat(25));
    for (let n = 0; n < 30; n += 1) bob.append(id, `ground ${n}\n`);
    await alice.online();

    const text = await converged(w.rest, id, [alice, bob]);
    expect(text).toContain("written on a plane. ".repeat(25));
    eachExactlyOnce(text, Array.from({ length: 30 }, (_, n) => `ground ${n}\n`));
  });
});

describe("both offline", () => {
  test("the same line edited on both sides: both edits, once each, everywhere", async () => {
    const id = await w.note("# Plan\n\nthe line\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);

    alice.offline();
    bob.offline();
    alice.insertAfter(id, "the line", " +alice");
    bob.insertAfter(id, "the line", " +bob");
    alice.insertAfter(id, "# Plan", " A");
    bob.insertAfter(id, "# Plan", " B");
    await Promise.all([alice.online(), bob.online()]);

    const text = await converged(w.rest, id, [alice, bob]);
    expect(text).toMatch(/^# Plan( A B| B A)\n/);
    expect(text).toMatch(/the line( \+alice \+bob| \+bob \+alice)/);
  });

  test("they come back one at a time, in either order", async () => {
    for (const order of [["alice", "bob"], ["bob", "alice"]] as const) {
      const id = await w.note("# Order\n\n");
      const peers = { alice: await w.device("alice"), bob: await w.device("bob", BOB) };
      for (const peer of Object.values(peers)) await peer.open(id);
      peers.alice.offline();
      peers.bob.offline();
      peers.alice.append(id, "a1\n");
      peers.bob.append(id, "b1\n");
      await peers[order[0]].online();
      peers[order[1]].append(id, `${order[1][0]}2\n`);
      await peers[order[1]].online();
      const text = await converged(w.rest, id, Object.values(peers));
      eachExactlyOnce(text, ["a1\n", "b1\n", `${order[1][0]}2\n`]);
    }
  });

  test("three devices, all offline, all editing, all back at once", async () => {
    const id = await w.note("# Three\n\n");
    const devices = [await w.device("alice"), await w.device("bob", BOB), await w.device("bob-phone", BOB)];
    for (const device of devices) await device.open(id);
    for (const device of devices) device.offline();
    const tokens: string[] = [];
    for (let n = 0; n < 20; n += 1) {
      for (const device of devices) {
        const token = `${device.name}:${n}\n`;
        tokens.push(token);
        device.append(id, token);
      }
    }
    await Promise.all(devices.map((device) => device.online()));
    eachExactlyOnce(await converged(w.rest, id, devices), tokens);
  });
});

describe("a flaky connection", () => {
  test("edits in flight when the wire drops are sent again, and only once", async () => {
    const id = await w.note("# In flight\n\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);

    for (let n = 0; n < 5; n += 1) {
      alice.latency(300);
      alice.append(id, `lost-in-flight ${n}\n`);
      await sleep(50);
      alice.offline(); // the frame never left
      alice.latency(0);
      await alice.online();
    }
    eachExactlyOnce(
      await converged(w.rest, id, [alice, bob]),
      Array.from({ length: 5 }, (_, n) => `lost-in-flight ${n}\n`),
    );
  });

  test("the connection blips every 100 ms while two people type", async () => {
    const id = await w.note("# Blips\n\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);

    let typing = true;
    const blipper = (async () => {
      while (typing) {
        await sleep(100);
        alice.blip();
        await sleep(40);
        bob.blip();
      }
    })();
    const tokens: string[] = [];
    await Promise.all(
      [alice, bob].map(async (peer) => {
        for (let n = 0; n < 60; n += 1) {
          const token = `${peer.name}-${n};`;
          tokens.push(token);
          peer.append(id, token);
          await sleep(15);
        }
      }),
    );
    typing = false;
    await blipper;
    await Promise.all([alice.online(), bob.online()]);
    eachExactlyOnce(await converged(w.rest, id, [alice, bob]), tokens);
    // Proof the blips happened: each one cost a reconnect.
    expect(alice.connects + bob.connects).toBeGreaterThan(6);
  });

  test("one device flaps offline and online while the other types steadily", async () => {
    const id = await w.note("# Flapping\n\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);

    const tokens: string[] = [];
    for (let n = 0; n < 12; n += 1) {
      if (n % 2 === 0) alice.offline();
      else await alice.online();
      alice.append(id, `a${n};`);
      bob.append(id, `b${n};`);
      tokens.push(`a${n};`, `b${n};`);
      await sleep(60);
    }
    await alice.online();
    eachExactlyOnce(await converged(w.rest, id, [alice, bob]), tokens);
  });
});

describe("closing the tab while offline", () => {
  test("the edits are on the device, and go up from the next visit", async () => {
    const id = await w.note("# Closed tab\n\nbase\n");
    const alice = await w.device("alice");
    const bob = await w.device("bob", BOB);
    await alice.open(id);
    await bob.open(id);

    alice.offline();
    alice.append(id, "typed, then the tab was closed\n");
    const saved = alice.persist();
    await alice.close();
    bob.append(id, "bob meanwhile\n");

    const reopened = Peer.revive("alice-again", alice.baseUrl, alice.token, saved);
    await reopened.online();
    await reopened.open(id);
    eachExactlyOnce(await converged(w.rest, id, [reopened, bob]), [
      "typed, then the tab was closed\n",
      "bob meanwhile\n",
    ]);
    await reopened.close();
  });

  test("two tabs of one device, both offline: neither loses the other's edit", async () => {
    const id = await w.note("# Two tabs\n\nbase\n");
    const tab1 = await w.device("tab1");
    await tab1.open(id);
    // The second tab starts from what the first had stored: one device, one database.
    const tab2 = Peer.revive("tab2", tab1.baseUrl, tab1.token, tab1.persist());
    tab1.offline();
    tab1.append(id, "from tab one\n");
    tab2.append(id, "from tab two\n");
    const saved = tab1.persist();
    await tab1.close();
    await tab2.online();
    const tab3 = Peer.revive("tab3", tab2.baseUrl, tab2.token, saved);
    await tab3.online();
    eachExactlyOnce(await converged(w.rest, id, [tab2, tab3]), ["from tab one\n", "from tab two\n"]);
    await Promise.all([tab2.close(), tab3.close()]);
  });

  test("a device offline for a long time catches up on a lot, and adds its own", async () => {
    const id = await w.note("# Holiday\n\n");
    const alice = await w.device("alice");
    await alice.open(id);
    const bob = await w.device("bob", BOB);
    await bob.open(id);
    alice.offline();
    alice.append(id, "postcard\n");
    for (let n = 0; n < 200; n += 1) bob.append(id, `work ${n}\n`);
    await converged(w.rest, id, [bob]);
    const saved = alice.persist();
    await alice.close();
    const home = Peer.revive("alice-home", alice.baseUrl, alice.token, saved);
    await home.online();
    const text = await converged(w.rest, id, [home, bob]);
    eachExactlyOnce(text, ["postcard\n", ...Array.from({ length: 200 }, (_, n) => `work ${n}\n`)]);
    await home.close();
  });
});

test("nothing a device does offline reaches anyone until it reconnects", async () => {
  const id = await w.note("# Quiet\n\n");
  const alice = await w.device("alice", ALICE);
  const bob = await w.device("bob", BOB);
  await alice.open(id);
  await bob.open(id);
  alice.offline();
  alice.append(id, "secret draft\n");
  await sleep(500);
  expect(bob.text(id)).toBe("# Quiet\n\n");
  expect(await serverText(w.rest, id)).toBe("# Quiet\n\n");
  await alice.online();
  await converged(w.rest, id, [alice, bob]);
});
