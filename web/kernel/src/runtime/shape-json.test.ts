/**
 * The `s.*` builders serialise: `toJSON()` is what a manifest's `backend.exports` declares
 * and the server validates backend calls with, and `shapeFromJSON` rebuilds a validator
 * from that JSON.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { s, shapeFromJSON, validate, type ShapeJson } from "@kernel";

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

  it("serialises a function with argument shapes as plain func", () => {
    expect(s.fn([s.string()], s.number()).toJSON()).toBe("func");
    expect(s.promise(s.string()).toJSON()).toBe("promise");
  });
});

/**
 * The shared shapes corpus (`backend/crates/core/corpus/shapes.json`): the Rust validator
 * that checks `backend.exports` and this one answer every case the same way.
 */
describe("the shapes corpus", () => {
  const corpus = resolve(web, "../backend/crates/core/corpus/shapes.json");
  interface Case {
    readonly name: string;
    readonly shape: ShapeJson;
    readonly value: unknown;
    readonly ok: boolean;
  }

  it.skipIf(!existsSync(corpus))("agrees with the Rust validator on every case", () => {
    const cases = JSON.parse(readFileSync(corpus, "utf8")) as Case[];
    expect(cases.length).toBeGreaterThan(0);
    for (const entry of cases) {
      const issues = validate(shapeFromJSON(entry.shape), entry.value);
      expect(issues.length === 0, `${entry.name}: ${JSON.stringify(issues)}`).toBe(entry.ok);
    }
  });
});
