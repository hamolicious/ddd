#!/usr/bin/env node
/**
 * Fill a running workspace with randomly connected notes, for looking at the graph view.
 *
 * Every run makes a **new top-level folder note** (`graph-seed-<timestamp>`) holding one
 * note per cluster, so runs never collide and each shows in its own colour with "colour by
 * folder". Inside it, notes are wired so the graph has some structure:
 *
 * - most links go to notes that already have many (a few hubs emerge, like a real vault);
 * - notes come in loose clusters that link mostly among themselves;
 * - some links are embeds or a frontmatter `parent:`, a few point at notes that do not
 *   exist, and a few notes link nowhere (orphans).
 *
 * Ids are minted here (ULIDs), so a note's links are written in the one `POST` that creates
 * it: no second pass of edits.
 *
 * Usage:
 *   node scripts/seed-graph.mjs [--count 500] [--url http://localhost:8080]
 *                               [--email you@example.com] [--password …] [--seed 42]
 *
 * `--email`/`--password` default to `DDD_EMAIL`/`DDD_PASSWORD`, `--url` to `DDD_APP`.
 */

import { randomBytes } from "node:crypto";

const options = parseArgs(process.argv.slice(2));
const count = Number(options.count ?? 500);
const baseUrl = String(options.url ?? process.env.DDD_APP ?? "http://localhost:8080").replace(/\/$/, "");
const email = options.email ?? process.env.DDD_EMAIL;
const password = options.password ?? process.env.DDD_PASSWORD;
const concurrency = Number(options.concurrency ?? 16);
const random = mulberry32(Number(options.seed ?? Date.now()));

if (!Number.isInteger(count) || count < 1) fail("--count must be a positive whole number");
if (!email || !password) fail("sign-in needed: pass --email and --password, or set DDD_EMAIL and DDD_PASSWORD");

// To the millisecond: two runs in the same second still get two folders.
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-").slice(0, 19);
const folder = `graph-seed-${stamp}`;

// ---------------------------------------------------------------------------
// The notes
// ---------------------------------------------------------------------------

const WORDS = [
  "atlas", "harbor", "lantern", "meadow", "orbit", "quartz", "river", "summit", "thistle", "willow",
  "ember", "fable", "garnet", "hollow", "iris", "juniper", "kestrel", "lagoon", "marble", "nimbus",
  "oak", "pebble", "quill", "raven", "saffron", "tundra", "umber", "velvet", "wren", "zephyr",
];
const TOPICS = ["Project", "Idea", "Meeting", "Reading", "Journal", "Recipe", "Research", "Plan", "Draft", "Review"];

const pick = (list) => list[Math.floor(random() * list.length)];
const clusterCount = Math.max(1, Math.round(count / 40));

const notes = Array.from({ length: count }, (_, index) => ({
  id: ulid(),
  title: `${pick(TOPICS)} ${pick(WORDS)} ${index + 1}`,
  cluster: Math.floor(random() * clusterCount),
  links: [],
  embeds: [],
  parent: undefined,
}));

const byCluster = new Map();
for (const note of notes) {
  if (!byCluster.has(note.cluster)) byCluster.set(note.cluster, []);
  byCluster.get(note.cluster).push(note);
}

// Preferential attachment: a note is a target in proportion to (1 + links it already has).
const weight = new Map(notes.map((note) => [note.id, 1]));
function weightedPick(candidates) {
  let total = 0;
  for (const candidate of candidates) total += weight.get(candidate.id);
  let roll = random() * total;
  for (const candidate of candidates) {
    roll -= weight.get(candidate.id);
    if (roll <= 0) return candidate;
  }
  return candidates[candidates.length - 1];
}

for (const [index, note] of notes.entries()) {
  if (random() < 0.03) continue; // an orphan, unless something links to it
  const outgoing = 1 + Math.floor(random() * random() * 5);
  const seen = new Set([note.id]);
  for (let i = 0; i < outgoing; i += 1) {
    // Mostly inside its own cluster; now and then anywhere earlier in the run.
    const pool = random() < 0.95 ? byCluster.get(note.cluster) : notes.slice(0, Math.max(1, index));
    const target = weightedPick(pool);
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    weight.set(target.id, weight.get(target.id) + 1);
    if (random() < 0.1) note.embeds.push(target);
    else note.links.push(target);
  }
  if (random() < 0.15) {
    const parent = pick(byCluster.get(note.cluster));
    if (parent !== note) note.parent = parent;
  }
  if (random() < 0.02) note.missing = ulid();
}

// The folder notes: one for the run, one per cluster inside it (`folders`' own format:
// a `%%% folders` section listing the children).
const clusterNotes = Array.from({ length: clusterCount }, (_, index) => ({ id: ulid(), title: `cluster-${index + 1}` }));
const folderNote = { id: ulid(), title: folder };
const folderText = (title, children) =>
  `---\ntitle: ${title}\n---\n\n# ${title}\n\n%%% folders\nchildren:\n${children.map((child) => `  - ${child.id}\n`).join("")}%%%\n`;

function text(note) {
  const lines = ["---", `title: ${note.title}`];
  if (note.parent) lines.push(`parent: doc://${note.parent.id}`);
  lines.push("---", "", `Seeded note ${note.title}.`, "");
  for (const target of note.links) lines.push(`- See [${target.title}](doc://${target.id})`);
  if (note.missing) lines.push(`- A link to a note that does not exist: [nowhere](doc://${note.missing})`);
  for (const target of note.embeds) lines.push("", `![${target.title}](doc://${target.id})`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Sending them
// ---------------------------------------------------------------------------

const token = await signIn();
let done = 0;
let failed = 0;
const started = Date.now();
const queue = [
  { id: folderNote.id, title: folderNote.title, content: folderText(folderNote.title, clusterNotes) },
  ...clusterNotes.map((cluster, index) => ({
    id: cluster.id,
    title: cluster.title,
    content: folderText(cluster.title, notes.filter((note) => note.cluster === index)),
  })),
  ...notes,
];
await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let note = queue.shift(); note; note = queue.shift()) {
      const response = await fetch(`${baseUrl}/api/documents`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ id: note.id, content: note.content ?? text(note) }),
      });
      if (response.ok) done += 1;
      else {
        failed += 1;
        console.error(`\n${note.title}: ${response.status} ${await response.text()}`);
      }
      if (process.stderr.isTTY) process.stderr.write(`\r${done}/${count + clusterCount + 1} created`);
    }
  }),
);

const links = notes.reduce((sum, note) => sum + note.links.length + note.embeds.length + (note.parent ? 1 : 0), 0);
process.stderr.write(`${process.stderr.isTTY ? "\r" : ""}${done}/${count + clusterCount + 1} created in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
console.log(`folder: ${folder}  (${clusterCount} clusters, ~${links} connections)`);
if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

async function signIn() {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, bearer: true }),
  }).catch((error) => fail(`cannot reach ${baseUrl}: ${error.cause?.message ?? error.message}`));
  if (!response.ok) fail(`sign-in failed: ${response.status} ${await response.text()}`);
  const body = await response.json();
  if (!body.token) fail("sign-in did not return a bearer token");
  return body.token;
}

/** A ULID: 48 bits of milliseconds, 80 random bits, Crockford base32. */
function ulid() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = Date.now();
  let out = "";
  for (let i = 0; i < 10; i += 1) {
    out = alphabet[time % 32] + out;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i += 1) out += alphabet[bytes[i] % 32];
  return out;
}

/** A small seeded PRNG, so `--seed` reproduces a layout of links. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log("node scripts/seed-graph.mjs [--count 500] [--url URL] [--email E] [--password P] [--seed N] [--concurrency 16]");
      process.exit(0);
    }
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const [key, inline] = arg.slice(2).split("=", 2);
    out[key] = inline ?? argv[++i];
  }
  return out;
}

function fail(message) {
  console.error(`seed-graph: ${message}`);
  process.exit(1);
}
