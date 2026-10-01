/**
 * Seeded chaos: devices of two people doing random things to a few shared notes —
 * editing (body, frontmatter splices, `%%%` lines, headings), dropping off, coming
 * back, blipping, lagging, closing the tab offline and reopening it, and making new
 * notes offline — then everyone comes back and every note must agree everywhere.
 *
 * The edits are the convergence harness's (`harness/src/ops.ts`): every body insert
 * carries a unique marker and no edit ever cuts into one, so "every marker exactly
 * once" is an exact test for a lost or doubled update.
 *
 * `DDD_COLLAB_SEEDS=20` runs more seeds; `DDD_COLLAB_SEED=7` runs just one. A failing
 * seed prints its journal and fails again the same way: the script is seeded, only
 * the network timing is real.
 */

import { afterAll, beforeAll, expect, test } from "vitest";

import { applyOp, chooseOp, markersIn, seedDocumentText } from "../harness/src/ops.js";
import { rng } from "../harness/src/scenario.js";
import { Peer } from "./peer.js";
import { ALICE, BOB, converged, sleep, world, type World } from "./world.js";

const STEPS = Number(process.env["DDD_COLLAB_STEPS"] ?? 160);
const seeds = process.env["DDD_COLLAB_SEED"]
  ? [Number(process.env["DDD_COLLAB_SEED"])]
  : Array.from({ length: Number(process.env["DDD_COLLAB_SEEDS"] ?? 6) }, (_, index) => index + 1);

let w: World;
beforeAll(async () => {
  w = await world(8134);
});
afterAll(() => w?.close());

test.each(seeds)("seed %i: every note converges and no edit is lost or doubled", async (seed) => {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const journal: string[] = [];
  const log = (line: string) => journal.push(line);

  const notes: string[] = [];
  for (let index = 0; index < 3; index += 1) notes.push(await w.note(seedDocumentText(seed * 10 + index, random)));
  const devices: Peer[] = [
    await w.device("alice-laptop", ALICE),
    await w.device("alice-phone", ALICE),
    await w.device("bob-laptop", BOB),
    await w.device("bob-phone", BOB),
  ];
  for (const device of devices) for (const id of notes) await device.open(id);
  /** Every marker written, by anyone, into any note. */
  const written = new Map<string, string[]>(notes.map((id) => [id, []]));
  /** Notes made during the run, with the device that made them. */
  const madeBy = new Map<string, Peer>();
  const counters = new Map<string, number>();

  try {
    for (let step = 0; step < STEPS; step += 1) {
      const slot = Math.floor(random() * devices.length);
      const device = devices[slot] as Peer;
      const roll = random();
      if (roll < 0.06) {
        log(`${step} ${device.name} offline`);
        device.offline();
      } else if (roll < 0.12) {
        log(`${step} ${device.name} online`);
        await device.online();
      } else if (roll < 0.15) {
        log(`${step} ${device.name} blip`);
        device.blip();
      } else if (roll < 0.18) {
        const ms = pick([0, 0, 50, 200]);
        log(`${step} ${device.name} latency ${ms}`);
        device.latency(ms);
      } else if (roll < 0.2) {
        // Close the tab (maybe offline) and reopen it from what the device stored.
        const wasOnline = device.connected;
        log(`${step} ${device.name} reload (${wasOnline ? "online" : "offline"})`);
        const saved = device.persist();
        await device.close();
        const reopened = Peer.revive(device.name, device.baseUrl, device.token, saved);
        devices[slot] = reopened;
        for (const [id, maker] of madeBy) if (maker === device) madeBy.set(id, reopened);
        if (wasOnline) await reopened.online();
      } else if (roll < 0.22 && madeBy.size < 4) {
        const id = await device.create(`# made by ${device.name} at ${step}\n\n`);
        log(`${step} ${device.name} create ${id} (${device.connected ? "online" : "offline"})`);
        madeBy.set(id, device);
        written.set(id, []);
      } else {
        const own = [...madeBy].filter(([, maker]) => maker === device).map(([id]) => id);
        const shared = [...madeBy.keys()].filter((id) => !own.includes(id) && device.has(id));
        const id = pick([...notes, ...own, ...shared]);
        if (!device.has(id)) {
          if (!device.connected) continue;
          await device.open(id);
        }
        const count = (counters.get(device.name) ?? 0) + 1;
        counters.set(device.name, count);
        const record = applyOp(device.yText(id), id, `${device.name}-s${seed}`, count, random, chooseOp(random));
        log(`${step} ${device.name} ${record.kind} ${id.slice(-6)} ${record.detail}`);
        if (record.applied && record.marker) written.get(id)?.push(record.marker);
      }
      if (step % 20 === 19) await sleep(50);
    }

    // Everyone back, with a working link, and every note open everywhere.
    for (const device of devices) device.latency(0);
    await Promise.all(devices.map((device) => device.online()));
    const everything = [...notes, ...madeBy.keys()];
    for (const device of devices) for (const id of everything) await device.open(id);

    for (const id of everything) {
      const text = await converged(w.rest, id, devices, 30_000);
      const seen = markersIn(text);
      const expected = written.get(id) ?? [];
      const missing = expected.filter((marker) => !seen.includes(marker));
      const doubled = seen.filter((marker, index) => seen.indexOf(marker) !== index);
      expect({ id, missing, doubled }).toEqual({ id, missing: [], doubled: [] });
      expect((await w.rest.getDocument(id)).fm_parse_error, `${id} frontmatter`).toBe(false);
    }
  } catch (error) {
    console.error(`seed ${seed} failed; replay with DDD_COLLAB_SEED=${seed}. Journal:\n${journal.join("\n")}`);
    throw error;
  } finally {
    await Promise.all(devices.map((device) => device.close()));
  }
});
