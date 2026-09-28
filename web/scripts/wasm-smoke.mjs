/**
 * Smoke test for the generated Wasm package — the last step of `mise run wasm`.
 *
 * It imports the artifact the way Node has to (the `web` target resolves its
 * `.wasm` relative to `import.meta.url` in a browser; in Node we hand it the
 * bytes), then exercises each exported function once. A build that links but
 * traps on the first call is the failure this catches.
 *
 * Usage: `node web/scripts/wasm-smoke.mjs` (from anywhere).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const pkg = new URL("../kernel/src/wasm/pkg/", import.meta.url);

const init = await import(new URL("./life_manager_core.js", pkg).href);
await init.default({
  module_or_path: await readFile(fileURLToPath(new URL("./life_manager_core_bg.wasm", pkg))),
});

const text = "---\ntitle: Groceries\npath: home/lists\n---\n\n# Groceries\n\n- [ ] milk\n\n%%% calendar\nsource-uid: abc123\n%%%\n";
const parsed = JSON.parse(init.parse_document(text));

const checks = [
  ["title resolves from frontmatter", parsed.title === "Groceries"],
  ["frontmatter parses", parsed.fm.path === "home/lists"],
  ["machine sections parse", parsed.plugins.calendar?.["source-uid"] === "abc123"],
  ["no parse error", parsed.fm_parse_error === false],
  [
    "filter matches",
    init.evaluate_filter(
      JSON.stringify({ cmp: { field: "fm.path", op: "eq", value: { str: "home/lists" } } }),
      JSON.stringify({
        id: "01J8ZQ0M3M4YQV0X0PTN9R2G7C",
        title: parsed.title,
        content: text,
        fm: parsed.fm,
        plugins: parsed.plugins,
        deleted: false,
      }),
    ) === true,
  ],
  [
    "filter rejects",
    init.evaluate_filter(
      JSON.stringify({ cmp: { field: "fm.path", op: "eq", value: { str: "elsewhere" } } }),
      JSON.stringify({ id: "x", title: "", content: "", fm: parsed.fm, plugins: {}, deleted: false }),
    ) === false,
  ],
  ["bad input is total, not a trap", init.evaluate_filter("{{{", "{{{") === false],
  ["semantics version is exported", Number.isInteger(init.core_semantics_version())],
  ["date normalization is shared", init.normalize_date("2026-9-3") !== ""],
  ["title resolver is exported", init.resolve_title("# Hello\n") === "Hello"],
];

// The wiring corpus (PLUGIN-PROTOCOLS §9 step 4) through the Wasm build: the wiring editor
// previews with exactly the resolver the server runs (`crates/core/tests/wiring.rs`).
{
  const corpusPath = new URL("../../backend/crates/core/corpus/wiring.json", import.meta.url);
  const corpus = JSON.parse(await readFile(fileURLToPath(corpusPath), "utf8"));
  const observed = (r) => ({
    order: r.order,
    skipped: Object.fromEntries(r.skipped.map((s) => [s.plugin, s.reason])),
    bindings: r.bindings,
    seats: r.seats,
    bench: r.bench,
    listeners: r.listeners,
    status: Object.fromEntries(
      Object.entries(r.status).map(([port, s]) => [port, s.count === undefined ? s.code : `${s.code}:${s.count}`]),
    ),
    diagnostics: r.diagnostics.map((d) => `${d.severity} ${d.code} ${d.plugin}`).sort(),
  });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sorted = (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))
      : Array.isArray(value) ? value.map(sorted) : value;
  for (const kase of corpus.cases) {
    const input = { plugins: kase.plugins, protocols: corpus.protocols, wiring: kase.wiring ?? {}, baseOnly: kase.base_only ?? false };
    const before = JSON.parse(init.resolve_wiring(JSON.stringify(input)));
    const got = observed(before);
    const bad = Object.entries(kase.expect ?? {}).filter(([field, want]) => !same(sorted(got[field]), sorted(want)));
    if (kase.plan) {
      const after = JSON.parse(init.resolve_wiring(JSON.stringify({ ...input, wiring: kase.plan.wiring })));
      const plan = JSON.parse(
        init.plan_wiring(
          JSON.stringify({ before, after, beforeWiring: kase.wiring ?? {}, afterWiring: kase.plan.wiring, hot: kase.plan.hot ?? [] }),
        ),
      );
      bad.push(...Object.entries(kase.plan.expect).filter(([field, want]) => !same(sorted(plan[field]), sorted(want))));
    }
    checks.push([`wiring: ${kase.name}`, bad.length === 0 || (console.error(bad), false)]);
  }
  checks.push(["wiring: bad input is total", JSON.parse(init.resolve_wiring("{{{")).error !== undefined]);
  checks.push(["wiring: shapes fit through Wasm", init.shape_fits('"string"', '{"literal":["a"]}') !== "[]"]);
}

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) failed++;
}

console.log(
  failed === 0
    ? `\nwasm smoke passed (${checks.length} checks, core semantics v${init.core_semantics_version()})`
    : `\nwasm smoke FAILED (${failed}/${checks.length})`,
);
process.exit(failed === 0 ? 0 : 1);
