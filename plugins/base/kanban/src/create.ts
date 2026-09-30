/**
 * New notes for boards, pure: the text of a new board's notes, and what a new card in a
 * column is born with.
 *
 * **A new board is one note** (`_shared/saved-view-mode.tsx`): a saved search for the
 * notes inside itself, `type: kanban`, starting with {@link BOARD_OPTIONS}. The board is
 * the note, and its tickets are its children — ordinary notes, filed like any others.
 *
 * **A new card belongs where it is added** (`cardFields`). It gets its column's value and
 * whatever the board's search asks of every
 * note it shows and a note can be given: the parent of an "is inside note" condition (the
 * card is filed there), and the value of an "is" condition on a top-level property. So a
 * card added to a board is on that board, in that column. Its place at the end of the
 * column is not a property: `index.tsx` writes it to the card's `%%% kanban` section.
 */

import type { CoreValue } from "@kernel";
import type { SearchSpec } from "plugin:search";

import { yamlScalar } from "../../_shared/yaml.js";

import { writableField } from "./layout.js";

export const CARD_TITLE = "Untitled";

/** The columns a new board starts with. */
export const STARTER_COLUMNS = "todo,doing,done";

/** A new board's settings: its starter columns. */
export const BOARD_OPTIONS: Readonly<Record<string, string>> = { columns: STARTER_COLUMNS };

/** A frontmatter value as the line writes it: numbers and booleans bare, text quoted when it must be. */
function scalar(value: CoreValue): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return yamlScalar(value);
  return yamlScalar(JSON.stringify(value));
}

/**
 * A new note's whole text: its frontmatter — a title and these properties — and no body.
 * Written wholesale because at creation there is nothing to merge with (SPEC §3.3).
 */
export function noteText(title: string, fm: Readonly<Record<string, CoreValue>> = {}): string {
  const lines = Object.entries(fm).map(([key, value]) => `${key}: ${scalar(value)}`);
  return ["---", `title: ${yamlScalar(title)}`, ...lines, "---", ""].join("\n");
}

export interface CardFields {
  /** Where to file it: the note an "is inside note" condition names. */
  readonly parent?: string;
  readonly fm: Readonly<Record<string, CoreValue>>;
}

/**
 * What a card added to a column is born with: see the file's header. Only an "and" filter
 * says what *every* note shown has, so an "or" filter bakes nothing in but the column.
 */
export function cardFields(
  spec: SearchSpec,
  group: { readonly field: string; readonly value: CoreValue | undefined },
): CardFields {
  const fm: Record<string, CoreValue> = {};
  let parent: string | undefined;
  if (spec.filter.combine === "and") {
    for (const clause of spec.filter.clauses) {
      if (clause.negate === true || clause.value.trim() === "") continue;
      if (clause.op === "child_of" && parent === undefined) parent = clause.value.trim();
      else if (clause.op === "eq" && writableField(clause.field)) fm[clause.field.slice(3)] = literal(clause.kind, clause.value);
    }
  }
  if (group.value !== undefined && writableField(group.field)) fm[group.field.slice(3)] = group.value;
  return { ...(parent !== undefined ? { parent } : {}), fm };
}

/** A condition's typed value as the property to write. */
function literal(kind: string, raw: string): CoreValue {
  const text = raw.trim();
  if (kind === "int" || kind === "float") {
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
  }
  if (kind === "bool") return text.toLowerCase() === "true";
  if (kind === "doc") return `doc://${text}`;
  return raw;
}
