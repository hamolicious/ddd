/**
 * The `s.*` builders serialise (PLUGIN-PROTOCOLS §3): `toJSON()` is what a protocol package
 * stores and the wiring type check reads, and `shapeFromJSON` is how the kernel validates
 * against a protocol it only knows as data.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { s, shapeFromJSON, splitProtocolRef, validate, type PluginManifest, type ProtocolPackage, type ShapeJson } from "@kernel";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("shapes as JSON", () => {
  const navbarItem = s.object({
    id: s.string(),
    label: s.string(),
    icon: s.optional(s.any()),
    side: s.optional(s.literal("start", "end")),
    onSelect: s.optional(s.func()),
    tags: s.optional(s.array(s.string())),
    tokens: s.record(s.string()),
    ready: s.promise(),
    either: s.union(s.string(), s.number()),
  });

  it("serialises in the s.* vocabulary", () => {
    expect(navbarItem.toJSON()).toEqual({
      object: {
        id: "string",
        label: "string",
        icon: { optional: "any" },
        side: { optional: { literal: ["start", "end"] } },
        onSelect: { optional: "func" },
        tags: { optional: { array: "string" } },
        tokens: { record: "string" },
        ready: "promise",
        either: { union: ["string", "number"] },
      },
    } satisfies ShapeJson);
  });

  it("rebuilds a validator that answers like the original", () => {
    const rebuilt = shapeFromJSON(navbarItem.toJSON());
    const good = { id: "a", label: "A", side: "end", tokens: {}, ready: Promise.resolve(), either: 1 };
    const bad = { id: 1, side: "middle", tokens: { x: 2 }, ready: 3, either: true };
    expect(validate(rebuilt, good)).toEqual([]);
    expect(validate(navbarItem, good)).toEqual([]);
    expect(validate(rebuilt, bad).map((i) => i.path).sort()).toEqual(
      validate(navbarItem, bad).map((i) => i.path).sort(),
    );
    expect(validate(rebuilt, bad).map((i) => i.path).sort()).toEqual(
      ["either", "id", "label", "ready", "side", "tokens.x"].sort(),
    );
  });

  it("keeps generation notes out of the JSON and the check", () => {
    const annotated = s.func().as("(path: string) => void").describe("Navigate.");
    expect(annotated.ts).toBe("(path: string) => void");
    expect(annotated.doc).toBe("Navigate.");
    expect(annotated.toJSON()).toBe("func");
    expect(validate(annotated, () => undefined)).toEqual([]);
    expect(validate(annotated, "nope")).toHaveLength(1);
  });
});

describe("the protocol packages", () => {
  const base = resolve(web, "../plugins/base");
  const packages: ProtocolPackage[] = readdirSync(base)
    .filter((owner) => existsSync(resolve(base, owner, "protocols")))
    .flatMap((owner) =>
      readdirSync(resolve(base, owner, "protocols")).map(
        (name) => JSON.parse(readFileSync(resolve(base, owner, "protocols", name, "protocol.json"), "utf8")) as ProtocolPackage,
      ),
    );

  it("cover every protocol a base or example manifest provides or consumes", () => {
    for (const tree of ["plugins/base", "plugins/examples"]) {
      const root = resolve(web, "..", tree);
      for (const id of readdirSync(root)) {
        const path = resolve(root, id, "manifest.json");
        if (!existsSync(path)) continue;
        const manifest = JSON.parse(readFileSync(path, "utf8")) as PluginManifest;
        for (const port of [...Object.values(manifest.provides ?? {}), ...Object.values(manifest.consumes ?? {})]) {
          const [protocol] = splitProtocolRef(port.protocol);
          expect(packages.some((p) => p.id === protocol), `${id}: ${port.protocol}`).toBe(true);
        }
      }
    }
    for (const service of ["lm/workspace-index", "lm/context-menu", "lm/shell"]) {
      expect(packages.find((p) => p.id === service), service).toMatchObject({ kind: "service" });
    }
  });

  it("are generated from their shape.mjs", () => {
    // Exits non-zero naming every stale file (and the protocols it read are checked for
    // ids, versions, kinds and keys on the way).
    const out = execFileSync("npx", ["vite-node", "scripts/gen-protocols.ts", "--check"], {
      cwd: web,
      encoding: "utf8",
    });
    expect(out).toMatch(/39 protocols up to date/);
  }, 60_000);
});
