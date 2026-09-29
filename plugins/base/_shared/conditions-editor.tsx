/**
 * The rows of a set of conditions (`conditions.ts`): "Match all/any", one row per
 * condition, and "Add condition". Used by `doc-list`'s filter bar and `folder-style`'s
 * rules.
 *
 * **Styled by its host.** Tailwind compiles each plugin's own `src/` with that plugin's
 * prefix, so a shared component cannot carry utility classes. It carries plain ones
 * instead, all starting with `classPrefix`, and the host styles them from its container
 * (`doclist:[&_.doclist-clause]:flex`):
 *
 * | Class | On |
 * |---|---|
 * | `-row` | the "Match" row and the button row |
 * | `-field` | each labelled input or select |
 * | `-grow` | the value field, which takes the spare width |
 * | `-checkbox` | the "not" toggle |
 * | `-clauses` | the list of rows |
 * | `-clause`, `-clause-invalid` | one row, and one that produces nothing |
 * | `-clause-note` | why it produces nothing |
 * | `-icon-button` | the remove button |
 * | `-note-option` | a note in the picker (`note-picker.tsx`) |
 * | `-note-chosen`, `-note-folder` | the chosen note, and the notes above it |
 *
 * **Suggestions come from the indexer** when the host has it (`conditions-index.ts`): the
 * property box offers every frontmatter key in use, the value box the values that key
 * holds, and choosing a known key sets the value type (and "list contains" for a list).
 *
 * **A row that produces nothing says why**, from `clauseProblem` — the same function the
 * builder answers to, so the mark and the filter cannot disagree.
 */

import { useEffect, useId, useReducer, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import {
  FIELD_OPTIONS,
  TREE_OPS,
  VALUELESS_OPS,
  clauseProblem,
  describeClause,
  newClauseId,
  type ClauseOp,
  type Conditions,
  type FieldOption,
  type FilterClause,
  type ValueKind,
} from "./conditions.js";
import type { Suggestions } from "./conditions-index.js";
import { NoteName, NotePicker, useNotes, type NoteSource } from "./note-picker.js";

export interface ConditionsEditorProps {
  readonly value: Conditions;
  readonly onChange: (value: Conditions) => void;
  /** The start of every class name here; see the table above. */
  readonly classPrefix: string;
  /** The notes "is inside note", "contains note" and a document value choose from; without it those are not offered. */
  readonly notes?: NoteSource;
  /** Properties and values to offer; without them, the fixed {@link FIELD_OPTIONS}. */
  readonly suggestions?: Suggestions;
  /** More buttons, after "Add condition". */
  readonly actions?: ReactNode;
}

const OP_LABELS: readonly { readonly op: ClauseOp; readonly label: string }[] = [
  { op: "eq", label: "is" },
  { op: "ne", label: "is not" },
  { op: "text_contains", label: "contains text" },
  { op: "text_starts_with", label: "starts with" },
  { op: "text_ends_with", label: "ends with" },
  { op: "gt", label: "is after / greater than" },
  { op: "gte", label: "is at least" },
  { op: "lt", label: "is before / less than" },
  { op: "lte", label: "is at most" },
  { op: "contains", label: "list contains" },
  { op: "contains_any", label: "list contains any of" },
  { op: "any", label: "any item is" },
  { op: "every", label: "every item is" },
  { op: "exists", label: "exists" },
  { op: "missing", label: "is missing" },
  { op: "is_null", label: "is null" },
  { op: "child_of", label: "is inside note" },
  { op: "parent_of", label: "contains note" },
];

const KIND_LABELS: readonly { readonly kind: ValueKind; readonly label: string }[] = [
  { kind: "str", label: "text" },
  { kind: "int", label: "whole number" },
  { kind: "float", label: "number" },
  { kind: "bool", label: "true/false" },
  { kind: "date", label: "date" },
  { kind: "null", label: "null" },
  { kind: "doc", label: "document" },
];

/** Operators that ask about a list, and the ones that ask about one value. */
const LIST_OPS: readonly ClauseOp[] = ["contains", "contains_any", "any", "every"];
const SCALAR_OPS: readonly ClauseOp[] = ["eq", "ne"];

/**
 * A known property chosen: take its value type, and swap "is" for "list contains" (or
 * back) to fit what it holds. Anything else the person chose is left alone.
 */
function fitToField(clause: FilterClause, option: FieldOption | undefined): Partial<FilterClause> {
  if (option === undefined) return {};
  const change: { kind?: ValueKind; op?: ClauseOp } = {};
  if (option.kind !== undefined && option.kind !== clause.kind) change.kind = option.kind;
  if (option.list === true && SCALAR_OPS.includes(clause.op)) change.op = "contains";
  if (option.list === false && LIST_OPS.includes(clause.op)) change.op = "eq";
  // A note id is no value for text, nor text for a note.
  if (change.kind !== undefined && (change.kind === "doc") !== (clause.kind === "doc")) return { ...change, value: "" };
  return change;
}


export function ConditionsEditor({
  value,
  onChange,
  classPrefix: p,
  notes,
  suggestions,
  actions,
}: ConditionsEditorProps): ReactElement {
  const fieldList = useId();
  // The index moves on every edit anywhere; the lists follow it.
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  useEffect(() => suggestions?.subscribe(refresh), [suggestions]);
  const fields = suggestions?.fields() ?? FIELD_OPTIONS;
  const problems = new Map(
    value.clauses
      .map((clause) => [clause.id, clauseProblem(clause)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  const ops = notes !== undefined ? OP_LABELS : OP_LABELS.filter((entry) => !TREE_OPS.includes(entry.op));

  const patch = (id: string, change: Partial<FilterClause>): void => {
    onChange({
      ...value,
      clauses: value.clauses.map((clause) => (clause.id === id ? { ...clause, ...change } : clause)),
    });
  };

  return (
    <>
      {value.clauses.length > 0 && (
        <>
          <div className={`${p}-row`}>
            <label className={`${p}-field`}>
              <span>Match</span>
              <select
                value={value.combine}
                onChange={(event) => onChange({ ...value, combine: event.target.value === "or" ? "or" : "and" })}
              >
                <option value="and">all conditions</option>
                <option value="or">any condition</option>
              </select>
            </label>
          </div>

          <ul className={`${p}-clauses`}>
            {value.clauses.map((clause) => {
              const tree = TREE_OPS.includes(clause.op);
              const valueless = VALUELESS_OPS.includes(clause.op);
              return (
                <li key={clause.id} className={`${p}-clause${problems.has(clause.id) ? ` ${p}-clause-invalid` : ""}`}>
                  {!tree && (
                    <label className={`${p}-field`}>
                      <input

                        aria-label="Field"
                        list={fieldList}
                        value={clause.field}
                        placeholder="Property name"
                        onChange={(event) => {
                          const field = event.target.value;
                          const known = fields.find((option) => option.field === field.trim());
                          patch(clause.id, { field, ...fitToField(clause, known) });
                        }}
                      />
                    </label>
                  )}

                  <label className={`${p}-field`}>
                    <select

                      aria-label="Operator"
                      value={clause.op}
                      onChange={(event) => {
                        const op = event.target.value as ClauseOp;
                        // A note id is no value for a property, nor the reverse.
                        const crossing = TREE_OPS.includes(op) !== tree;
                        patch(clause.id, { op, ...(crossing ? { value: "" } : {}) });
                      }}
                    >
                      {ops.map((entry) => (
                        <option key={entry.op} value={entry.op}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {tree && notes !== undefined && (
                    <NoteField
                      classPrefix={p}
                      notes={notes}
                      value={clause.value}
                      onChange={(id) => patch(clause.id, { value: id })}
                    />
                  )}

                  {!tree && !valueless && (
                    <>
                      <label className={`${p}-field`}>
                        <select

                          aria-label="Value type"
                          value={clause.kind}
                          onChange={(event) => patch(clause.id, { kind: event.target.value as ValueKind })}
                        >
                          {KIND_LABELS.map((entry) => (
                            <option key={entry.kind} value={entry.kind}>
                              {entry.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {clause.kind === "doc" && notes !== undefined ? (
                        <NoteField
                          classPrefix={p}
                          notes={notes}
                          value={clause.value}
                          onChange={(id) => patch(clause.id, { value: id })}
                        />
                      ) : (
                      <label className={`${p}-field ${p}-grow`}>
                        <input

                          aria-label="Value"
                          list={`${fieldList}-${clause.id}`}
                          value={clause.value}
                          placeholder={
                            clause.op === "contains_any"
                              ? "work, home"
                              : clause.kind === "date"
                                ? "2026-09-23"
                                : "Value"
                          }
                          onChange={(event) => patch(clause.id, { value: event.target.value })}
                        />
                        <datalist id={`${fieldList}-${clause.id}`}>
                          {(suggestions?.values(clause.field.trim()) ?? []).map((value) => (
                            <option key={value} value={value} />
                          ))}
                        </datalist>
                      </label>
                      )}
                    </>
                  )}

                  {clause.op === "child_of" && (
                    <label className={`${p}-checkbox`} title="Also notes inside the notes inside it, all the way down">
                      <input
                        type="checkbox"
                        checked={clause.deep === true}
                        onChange={(event) => patch(clause.id, { deep: event.target.checked })}
                      />
                      <span>including nested</span>
                    </label>
                  )}

                  <label className={`${p}-checkbox`}>
                    <input
                      type="checkbox"
                      checked={clause.negate === true}
                      onChange={(event) => patch(clause.id, { negate: event.target.checked })}
                    />
                    <span>not</span>
                  </label>

                  <button
                    type="button"
                    className={`${p}-icon-button`}
                    aria-label={`Remove condition: ${describeClause(clause)}`}
                    onClick={() =>
                      onChange({ ...value, clauses: value.clauses.filter((entry) => entry.id !== clause.id) })
                    }
                  >
                    ✕
                  </button>

                  {problems.has(clause.id) && (
                    <p className={`${p}-clause-note`}>Not applied. {problems.get(clause.id)}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <datalist id={fieldList}>
        {fields.map((option) => (
          <option key={option.field} value={option.field}>
            {option.label}
          </option>
        ))}
      </datalist>

      <div className={`${p}-row`}>
        <button
          type="button"
          onClick={() =>
            onChange({
              ...value,
              clauses: [...value.clauses, { id: newClauseId(), field: "fm.status", op: "eq", value: "", kind: "str" }],
            })
          }
        >
          Add condition
        </button>
        {actions}
      </div>
    </>
  );
}

/** A note: the picker until one is chosen, then the note as the tree draws it. */
function NoteField({
  classPrefix: p,
  notes,
  value,
  onChange,
}: {
  readonly classPrefix: string;
  readonly notes: NoteSource;
  readonly value: string;
  readonly onChange: (id: string) => void;
}): ReactElement {
  const byId = useNotes(notes);
  const [picking, setPicking] = useState(false);
  if (value === "" || picking) {
    return (
      <span className={`${p}-field ${p}-grow`}>
        <NotePicker
          source={notes}
          classPrefix={p}
          autoFocus={picking}
          onChoose={(id) => {
            setPicking(false);
            onChange(id);
          }}
        />
      </span>
    );
  }
  const note = byId.get(value);
  return (
    <span className={`${p}-field ${p}-grow`}>
      <button type="button" title="Choose another note" className={`${p}-note-chosen`} onClick={() => setPicking(true)}>
        {/* Not known on this device, or the index is still building: say so, not the id. */}
        <NoteName title={note?.title ?? "Unknown note"} look={notes.look?.(value)} />
        {note !== undefined && note.folder !== "" && <span className={`${p}-note-folder`}> {note.folder}</span>}
      </button>
    </span>
  );
}
