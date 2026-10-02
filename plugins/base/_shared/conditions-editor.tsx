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
  readonly classPrefix: string;
  readonly notes?: NoteSource;
  readonly NoteSelect?: ComponentType<NoteSelectLike>;
  readonly FmKeySelect?: ComponentType<FmKeySelectLike>;
  readonly FmValueSelect?: ComponentType<FmValueSelectLike>;
  readonly suggestions?: Suggestions;
  readonly actions?: ReactNode;
}

export interface NoteSelectLike {
  readonly value?: string;
  readonly onChange: (id: string) => void;
  readonly label?: string;
}

export interface FmKeySelectLike {
  readonly value: string;
  readonly onChange: (key: string) => void;
  readonly onPick?: (key: string) => void;
  readonly builtIn?: readonly { readonly key: string; readonly label: string }[];
  readonly placeholder?: string;
  readonly label?: string;
}

export interface FmValueSelectLike {
  readonly fmKey: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly multiple?: boolean;
  readonly placeholder?: string;
  readonly label?: string;
}

function keyOfField(field: string): string {
  return field.startsWith("fm.") ? field.slice(3) : field;
}

interface OpEntry {
  readonly op: ClauseOp;
  readonly label: string;
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

const LIST_OPS: readonly ClauseOp[] = ["contains", "contains_any", "any", "every"];
const SCALAR_OPS: readonly ClauseOp[] = ["eq", "ne"];

function kindsFor(op: ClauseOp): readonly ValueKind[] | undefined {
  if (TREE_OPS.includes(op) || VALUELESS_OPS.includes(op)) return undefined;
  if (TEXT_OPS.includes(op)) return ["str"];
  if (ORDERING_OPS.includes(op)) return ["str", "int", "float", "date"];
  return VALUE_KINDS;
}

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
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  useEffect(() => suggestions?.subscribe(refresh), [suggestions]);
  const fields = suggestions?.fields() ?? FIELD_OPTIONS;
  const builtIn = fields
    .filter((option) => !option.field.startsWith("fm."))
    .map((option) => ({ key: option.field, label: option.label }));
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

function valuePlaceholder(clause: FilterClause): string {
  return clause.op === "contains_any" ? "work, home" : clause.kind === "date" ? "2026-09-23" : "Value";
}

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
        <NoteName title={note?.title ?? "Unknown note"} look={notes.look?.(value)} />
        {note !== undefined && note.folder !== "" && <span className={`${p}-note-folder`}> {note.folder}</span>}
      </button>
    </span>
  );
}
