import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CoreMap } from "@kernel";
import { describe, expect, it } from "vitest";

import { extract, type Reference } from "./extract.js";
import { row } from "./rows.test-util.js";

interface Fixture {
  readonly name: string;
  readonly id: string;
  readonly text: string;
  readonly fm: CoreMap;
  readonly expected: {
    readonly words: number;
    readonly characters: number;
    readonly tasks: { readonly open: number; readonly done: number; readonly other: number };
    readonly references: readonly Reference[];
    readonly attachments: readonly string[];
  };
}

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../schema/fixtures/search-extract.json", import.meta.url)), "utf8"),
) as Fixture[];

const byTarget = (references: readonly Reference[]): Reference[] =>
  [...references].sort((a, b) => `${a.id}\u0000${a.kind}\u0000${a.key ?? ""}`.localeCompare(`${b.id}\u0000${b.kind}\u0000${b.key ?? ""}`));

describe("extract agrees with the search projection fixtures", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const data = extract(row(fixture.id, fixture.text, fixture.fm));
      expect({
        words: data.words,
        characters: data.characters,
        tasks: data.tasks,
        references: byTarget(data.references),
        attachments: [...data.attachments].sort(),
      }).toEqual({ ...fixture.expected, references: byTarget(fixture.expected.references) });
    });
  }
});
