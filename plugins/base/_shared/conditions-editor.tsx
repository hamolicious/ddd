/**
 * The rows of a set of conditions (`conditions.ts`): "Match all/any", one row per
 * condition, and "Add condition". Used by `search`'s filter bar and `folder-style`'s
 * rules.
 *
 * **A row is chosen left to right, and builds what is right of it.** The comparison
 * first, then the value type it allows, then the sentence those make: the property, an
 * icon for the operation, and the value. The two choices always sit first and always
 * render — a type that does not apply is disabled, not removed — so picking a
 * comparison never moves the boxes the person is aiming at. The property is left out
 * for the folder comparisons, which are about the note itself; the value is left out
 * where there is none (`exists`, a `null` type).
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
 * | `-checkbox` | the "not" and "including nested" toggles |
 * | `-flags` | the line under the row that holds them |
 * | `-op-icon` | the operation's symbol, between the property and the value |
 * | `-clauses` | the list of rows |
 * | `-clause`, `-clause-invalid` | one row, and one that produces nothing |
 * | `-clause-note` | why it produces nothing |
 * | `-icon-button` | the remove button |
 * | `-note-option` | a note in the picker (`note-picker.tsx`) |
 * | `-note-chosen`, `-note-folder` | the chosen note, and the notes above it |
 *
 * **A note value is chosen with `NoteSelect`** when the host passes one (`search`'s), and
 * with the picker here otherwise. Likewise the property box is `FmKeySelect` and the value
 * box `FmValueSelect` when passed, and an input over a `<datalist>` otherwise.
 *
 * **Suggestions come from the indexer** when the host has it (`conditions-index.ts`): the
 * property box offers every frontmatter key in use, the value box the values that key
 * holds, and choosing a known key sets the value type (and "list contains" for a list).
 *
 * **A row that produces nothing says why**, from `clauseProblem` — the same function the
 * builder answers to, so the mark and the filter cannot disagree.
 */

import { useEffect, useId, useReducer, useState } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";

import {
  FIELD_OPTIONS,
  ORDERING_OPS,
  TEXT_OPS,
  TREE_OPS,
  VALUELESS_OPS,
  VALUE_KINDS,
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
  /** Picks a note value: `search`'s `NoteSelect`. Without it, the picker in `note-picker.tsx`. */
  readonly NoteSelect?: ComponentType<NoteSelectLike>;
  /** The property box: `search`'s `FmKeySelect`. */
  readonly FmKeySelect?: ComponentType<FmKeySelectLike>;
  /** The value box: `search`'s `FmValueSelect`. */
  readonly FmValueSelect?: ComponentType<FmValueSelectLike>;
  /** Properties and values to offer; without them, the fixed {@link FIELD_OPTIONS}. */
  readonly suggestions?: Suggestions;
  /** More buttons, after "Add condition". */
  readonly actions?: ReactNode;
}

/** What this editor needs of `search`'s `NoteSelect`, so a shared file need not import it. */
export interface NoteSelectLike {
  readonly value?: string;
  readonly onChange: (id: string) => void;
  readonly label?: string;
}

/** What this editor needs of `search`'s `FmKeySelect`. */
export interface FmKeySelectLike {
  readonly value: string;
  readonly onChange: (key: string) => void;
  readonly builtIn?: readonly { readonly key: string; readonly label: string }[];
  readonly placeholder?: string;
  readonly label?: string;
}

/** What this editor needs of `search`'s `FmValueSelect`. */
export interface FmValueSelectLike {
  readonly fmKey: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly multiple?: boolean;
  readonly placeholder?: string;
  readonly label?: string;
}

/** The property box's text for a field path: a frontmatter key without its `fm.`. */
function keyOfField(field: string): string {
  return field.startsWith("fm.") ? field.slice(3) : field;
}

interface OpEntry {
  readonly op: ClauseOp;
  readonly label: string;
  /** The symbol drawn between the property and the value. */
  readonly icon: string;
}

const OP_GROUPS: readonly { readonly label: string; readonly ops: readonly OpEntry[] }[] = [
  {
    label: "Compare",
    ops: [
      { op: "eq", label: "is", icon: "=" },
      { op: "ne", label: "is not", icon: "≠" },
      { op: "gt", label: "is after / greater than", icon: ">" },
      { op: "gte", label: "is at least", icon: "≥" },
      { op: "lt", label: "is before / less than", icon: "<" },
      { op: "lte", label: "is at most", icon: "≤" },
    ],
  },
  {
    label: "Text",
    ops: [
      { op: "text_contains", label: "contains text", icon: "…a…" },
      { op: "text_starts_with", label: "starts with", icon: "a…" },
      { op: "text_ends_with", label: "ends with", icon: "…a" },
    ],
  },
  {
    label: "List",
    ops: [
      { op: "contains", label: "list contains", icon: "∋" },
      { op: "contains_any", label: "list contains any of", icon: "∋∨" },
      { op: "any", label: "any item is", icon: "∃=" },
      { op: "every", label: "every item is", icon: "∀=" },
    ],
  },
  {
    label: "Presence",
    ops: [
      { op: "exists", label: "exists", icon: "∃" },
      { op: "missing", label: "is missing", icon: "∄" },
      { op: "is_null", label: "is null", icon: "∅" },
    ],
  },
  {
    label: "Folder",
    ops: [
      { op: "child_of", label: "is inside note", icon: "⊂" },
      { op: "parent_of", label: "contains note", icon: "⊃" },
    ],
  },
];

const OP_BY_ID = new Map(OP_GROUPS.flatMap((group) => group.ops).map((entry) => [entry.op, entry] as const));

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
 * The value types a comparison takes, or `undefined` when it takes none: the folder
 * comparisons (a note) and the presence ones (nothing). Narrowed to what `clauseProblem`
 * accepts, so the list cannot offer a combination the row then refuses.
 */
function kindsFor(op: ClauseOp): readonly ValueKind[] | undefined {
  if (TREE_OPS.includes(op) || VALUELESS_OPS.includes(op)) return undefined;
  if (TEXT_OPS.includes(op)) return ["str"];
  if (ORDERING_OPS.includes(op)) return ["str", "int", "float", "date"];
  return VALUE_KINDS;
}

/**
 * A known property chosen: take its value type, and swap "is" for "list contains" (or
 * back) to fit what it holds. Anything else the person chose is left alone.
 */
function fitToField(clause: FilterClause, option: FieldOption | undefined): Partial<FilterClause> {
  if (option === undefined) return {};
  const change: { kind?: ValueKind; op?: ClauseOp } = {};
  if (option.list === true && SCALAR_OPS.includes(clause.op)) change.op = "contains";
  if (option.list === false && LIST_OPS.includes(clause.op)) change.op = "eq";
  const allowed = kindsFor(change.op ?? clause.op);
  if (option.kind !== undefined && option.kind !== clause.kind && allowed?.includes(option.kind) === true) {
    change.kind = option.kind;
  }
  return change;
}

/**
 * A row after a change: a type the comparison does not take becomes one it does, and a
 * value that meant something else — a note id where text was, or the reverse — is cleared.
 */
function settle(before: FilterClause, after: FilterClause): FilterClause {
  const allowed = kindsFor(after.op);
  const kind = allowed === undefined || allowed.includes(after.kind) ? after.kind : (allowed[0] as ValueKind);
  const isNote = (clause: { op: ClauseOp; kind: ValueKind }): boolean =>
    TREE_OPS.includes(clause.op) || (kindsFor(clause.op) !== undefined && clause.kind === "doc");
  const crossing = isNote(before) !== isNote({ op: after.op, kind });
  const bool = kind === "bool" && before.kind !== "bool";
  return { ...after, kind, ...(crossing ? { value: "" } : bool ? { value: "true" } : {}) };
}

export function ConditionsEditor({
  value,
  onChange,
  classPrefix: p,
  notes,
  NoteSelect,
  FmKeySelect,
  FmValueSelect,
  suggestions,
  actions,
}: ConditionsEditorProps): ReactElement {
  const fieldList = useId();
  // The index moves on every edit anywhere; the lists follow it.
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  useEffect(() => suggestions?.subscribe(refresh), [suggestions]);
  const fields = suggestions?.fields() ?? FIELD_OPTIONS;
  // The fields that are not frontmatter, which the property box lists first by name.
  const builtIn = fields
    .filter((option) => !option.field.startsWith("fm."))
    .map((option) => ({ key: option.field, label: option.label }));
  /** A field path from the property box's text: a built-in's name, or a frontmatter key. */
  const fieldOfKey = (key: string): string =>
    key === "" || builtIn.some((option) => option.key === key.trim()) ? key : `fm.${key}`;
  const problems = new Map(
    value.clauses
      .map((clause) => [clause.id, clauseProblem(clause)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  const groups = notes !== undefined ? OP_GROUPS : OP_GROUPS.filter((group) => group.label !== "Folder");

  const patch = (id: string, change: Partial<FilterClause>): void => {
    onChange({
      ...value,
      clauses: value.clauses.map((clause) => (clause.id === id ? settle(clause, { ...clause, ...change }) : clause)),
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
              const kinds = kindsFor(clause.op);
              const entry = OP_BY_ID.get(clause.op);
              const noteValue = notes !== undefined && (tree || (kinds !== undefined && clause.kind === "doc"));
              return (
                <li key={clause.id} className={`${p}-clause${problems.has(clause.id) ? ` ${p}-clause-invalid` : ""}`}>
                  <label className={`${p}-field`}>
                    <select
                      aria-label="Comparison"
                      value={clause.op}
                      onChange={(event) => patch(clause.id, { op: event.target.value as ClauseOp })}
                    >
                      {groups.map((group) => (
                        <optgroup key={group.label} label={group.label}>
                          {group.ops.map((option) => (
                            <option key={option.op} value={option.op}>
                              {option.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>

                  <label className={`${p}-field`}>
                    <select
                      aria-label="Value type"
                      value={kinds === undefined ? "" : clause.kind}
                      disabled={kinds === undefined}
                      onChange={(event) => patch(clause.id, { kind: event.target.value as ValueKind })}
                    >
                      {kinds === undefined ? (
                        <option value="">{tree ? "note" : "—"}</option>
                      ) : (
                        KIND_LABELS.filter((option) => kinds.includes(option.kind)).map((option) => (
                          <option key={option.kind} value={option.kind}>
                            {option.label}
                          </option>
                        ))
                      )}
                    </select>
                  </label>

                  {!tree && FmKeySelect !== undefined ? (
                    <span className={`${p}-field`}>
                      <FmKeySelect
                        value={keyOfField(clause.field)}
                        builtIn={builtIn}
                        onChange={(key) => {
                          const field = fieldOfKey(key);
                          const known = fields.find((option) => option.field === field.trim());
                          patch(clause.id, { field, ...fitToField(clause, known) });
                        }}
                      />
                    </span>
                  ) : !tree && (
                    <label className={`${p}-field`}>
                      <input
                        aria-label="Property"
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

                  <span className={`${p}-op-icon`} role="img" aria-label={entry?.label} title={entry?.label}>
                    {clause.negate === true ? "¬" : ""}
                    {entry?.icon}
                  </span>

                  {noteValue && NoteSelect !== undefined ? (
                    <span className={`${p}-field ${p}-grow`}>
                      <NoteSelect
                        label="Value"
                        {...(clause.value !== "" ? { value: clause.value } : {})}
                        onChange={(id) => patch(clause.id, { value: id })}
                      />
                    </span>
                  ) : noteValue && notes !== undefined ? (
                    <NoteField
                      classPrefix={p}
                      notes={notes}
                      value={clause.value}
                      onChange={(id) => patch(clause.id, { value: id })}
                    />
                  ) : kinds === undefined || clause.kind === "null" ? null : clause.kind === "bool" ? (
                    <label className={`${p}-field`}>
                      <select
                        aria-label="Value"
                        value={clause.value.trim().toLowerCase()}
                        onChange={(event) => patch(clause.id, { value: event.target.value })}
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    </label>
                  ) : FmValueSelect !== undefined ? (
                    <span className={`${p}-field ${p}-grow`}>
                      <FmValueSelect
                        fmKey={clause.field.startsWith("fm.") ? clause.field.slice(3) : ""}
                        value={clause.value}
                        multiple={clause.op === "contains_any"}
                        placeholder={valuePlaceholder(clause)}
                        onChange={(next) => patch(clause.id, { value: next })}
                      />
                    </span>
                  ) : (
                    <label className={`${p}-field ${p}-grow`}>
                      <input
                        aria-label="Value"
                        list={`${fieldList}-${clause.id}`}
                        value={clause.value}
                        placeholder={valuePlaceholder(clause)}
                        onChange={(event) => patch(clause.id, { value: event.target.value })}
                      />
                      <datalist id={`${fieldList}-${clause.id}`}>
                        {(suggestions?.values(clause.field.trim()) ?? []).map((value) => (
                          <option key={value} value={value} />
                        ))}
                      </datalist>
                    </label>
                  )}

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

                  <div className={`${p}-flags`}>
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
                  </div>

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

/** An example of what the value box takes. */
function valuePlaceholder(clause: FilterClause): string {
  return clause.op === "contains_any" ? "work, home" : clause.kind === "date" ? "2026-09-23" : "Value";
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
