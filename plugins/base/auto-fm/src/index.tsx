import { useEffect, useState, useSyncExternalStore, type ComponentType, type ReactElement } from "react";

import type { CoreValue, Kernel, SettingsValue } from "@kernel";
import type { FmKeySelectProps, FmValueSelectProps, NoteSelectProps } from "plugin:search";

import * as indexer from "plugin:indexer";
import { addSection } from "plugin:settings";

import { ConditionsEditor } from "../../_shared/conditions-editor.js";
import {
  indexNoteSource,
  indexSuggestions,
  type ConditionIndex,
  type Suggestions,
} from "../../_shared/conditions-index.js";
import { documentsNoteSource, type NoteSource } from "../../_shared/note-picker.js";

import {
  isKeyShaped,
  newField,
  parseFields,
  sameFields,
  serializeFields,
  type AutoField,
} from "./fields.js";
import { watch, type Watcher } from "./watcher.js";

const FIELDS_KEY = "fields";
const WRITE_DEBOUNCE_MS = 400;

const INPUT =
  "autofm:tap-h autofm:min-w-0 autofm:rounded autofm:border autofm:border-border autofm:bg-bg autofm:px-2 autofm:text-base autofm:text-text";
const BUTTON =
  "autofm:tap-h autofm:cursor-pointer autofm:rounded autofm:border autofm:border-border-strong autofm:bg-bg-raised autofm:px-1.5 autofm:font-sans autofm:text-text";

const CONDITIONS =
  "autofm:flex autofm:flex-col autofm:gap-2 " +
  "autofm:[&_button]:tap-h autofm:[&_button]:cursor-pointer autofm:[&_button]:rounded autofm:[&_button]:border autofm:[&_button]:border-border-strong autofm:[&_button]:bg-bg-raised autofm:[&_button]:px-1.5 autofm:[&_button]:text-text " +
  "autofm:[&_.autofm-row]:flex autofm:[&_.autofm-row]:flex-wrap autofm:[&_.autofm-row]:items-end autofm:[&_.autofm-row]:gap-2 " +
  "autofm:[&_.autofm-clauses]:m-0 autofm:[&_.autofm-clauses]:flex autofm:[&_.autofm-clauses]:list-none autofm:[&_.autofm-clauses]:flex-col autofm:[&_.autofm-clauses]:gap-2 autofm:[&_.autofm-clauses]:p-0 " +
  "autofm:[&_.autofm-clause]:flex autofm:[&_.autofm-clause]:flex-wrap autofm:[&_.autofm-clause]:items-end autofm:[&_.autofm-clause]:gap-1.5 autofm:[&_.autofm-clause]:rounded autofm:[&_.autofm-clause]:border autofm:[&_.autofm-clause]:border-transparent autofm:[&_.autofm-clause]:p-1 " +
  "autofm:[&_.autofm-clause-invalid]:border-warning " +
  "autofm:[&_.autofm-clause-note]:m-0 autofm:[&_.autofm-clause-note]:flex-[1_1_100%] autofm:[&_.autofm-clause-note]:text-sm autofm:[&_.autofm-clause-note]:text-warning " +
  "autofm:[&_.autofm-field]:flex autofm:[&_.autofm-field]:flex-col autofm:[&_.autofm-field]:gap-0.5 autofm:[&_.autofm-field]:text-sm autofm:[&_.autofm-field]:text-text-muted " +
  "autofm:[&_.autofm-field_input]:tap-h autofm:[&_.autofm-field_input]:rounded autofm:[&_.autofm-field_input]:border autofm:[&_.autofm-field_input]:border-border autofm:[&_.autofm-field_input]:bg-bg autofm:[&_.autofm-field_input]:px-2 autofm:[&_.autofm-field_input]:text-base autofm:[&_.autofm-field_input]:text-text " +
  "autofm:[&_.autofm-field_select]:tap-h autofm:[&_.autofm-field_select]:rounded autofm:[&_.autofm-field_select]:border autofm:[&_.autofm-field_select]:border-border autofm:[&_.autofm-field_select]:bg-bg autofm:[&_.autofm-field_select]:px-2 autofm:[&_.autofm-field_select]:text-base autofm:[&_.autofm-field_select]:text-text " +
  "autofm:[&_.autofm-grow]:flex-[1_1_12rem] autofm:compact:[&_.autofm-grow]:basis-full " +
  "autofm:[&_.autofm-checkbox]:tap-h autofm:[&_.autofm-checkbox]:inline-flex autofm:[&_.autofm-checkbox]:cursor-pointer autofm:[&_.autofm-checkbox]:items-center autofm:[&_.autofm-checkbox]:gap-1 autofm:[&_.autofm-checkbox]:whitespace-nowrap " +
  "autofm:[&_.autofm-icon-button]:min-w-[var(--ddd-tap-target)] " +
  "autofm:[&_.autofm-flags]:flex autofm:[&_.autofm-flags]:flex-[1_1_100%] autofm:[&_.autofm-flags]:flex-wrap autofm:[&_.autofm-flags]:items-center autofm:[&_.autofm-flags]:gap-3 " +
  "autofm:[&_.autofm-op-icon]:tap-h autofm:[&_.autofm-op-icon]:inline-flex autofm:[&_.autofm-op-icon]:min-w-[2ch] autofm:[&_.autofm-op-icon]:items-center autofm:[&_.autofm-op-icon]:justify-center autofm:[&_.autofm-op-icon]:px-1 autofm:[&_.autofm-op-icon]:font-mono autofm:[&_.autofm-op-icon]:text-text-muted autofm:[&_.autofm-op-icon]:whitespace-nowrap " +
  "autofm:[&_.autofm-note-results]:flex autofm:[&_.autofm-note-results]:flex-wrap autofm:[&_.autofm-note-results]:gap-1";


export default function activate(kernel: Kernel): void {
  kernel.settings.defineSchema({
    [FIELDS_KEY]: { type: "list", default: [] },
  });

  const listeners = new Set<() => void>();
  let version = 0;
  const publish = (): void => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };

  let pickers:
    | {
        readonly NoteSelect: ComponentType<NoteSelectProps>;
        readonly FmKeySelect: ComponentType<FmKeySelectProps>;
        readonly FmValueSelect: ComponentType<FmValueSelectProps>;
      }
    | undefined;
  void kernel.plugins
    .optional<typeof import("plugin:search")>("search")
    .then((module) => {
      if (module === undefined) return;
      pickers = { NoteSelect: module.NoteSelect, FmKeySelect: module.FmKeySelect, FmValueSelect: module.FmValueSelect };
      publish();
    })
    .catch((cause: unknown) => kernel.log.warn("search unavailable; properties are typed with suggestions", cause));
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  let fields = parseFields(kernel.settings.get(FIELDS_KEY));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  const save = (): void => {
    timer = undefined;
    const snapshot = serializeFields(fields);
    writes = writes
      .then(() => kernel.settings.set(FIELDS_KEY, snapshot as readonly CoreValue[] as SettingsValue))
      .catch((cause: unknown) => kernel.log.warn("could not store the automatic properties", cause));
  };
  const flush = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    save();
  };
  const change = (next: readonly AutoField[]): void => {
    if (sameFields(fields, next)) {
      fields = next;
      publish();
      return;
    }
    fields = next;
    watcher.refresh();
    publish();
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(save, WRITE_DEBOUNCE_MS);
  };

  const watcher: Watcher = watch({
    documents: kernel.documents,
    userId: kernel.session.user.id,
    fields: () => fields,
    active: () => typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus()),
    warn: (message, cause) => kernel.log.warn(message, cause),
  });

  try {
    kernel.settings.subscribe(() => {
      if (timer !== undefined) return;
      const stored = parseFields(kernel.settings.get(FIELDS_KEY));
      if (sameFields(fields, stored)) return;
      fields = stored;
      watcher.refresh();
      publish();
    });
  } catch (cause) {
    kernel.log.warn("automatic property changes on other devices will not be followed", cause);
  }

  stop = () => {
    flush();
    watcher.close();
  };

  const index = (): ConditionIndex => indexer;
  const fallbackNotes = documentsNoteSource(kernel.documents);
  let lookups: { index: ConditionIndex | undefined; notes: NoteSource; suggestions: Suggestions | undefined } | undefined;
  const lookupsFor = (current: ConditionIndex | undefined) => {
    if (lookups === undefined || lookups.index !== current) {
      lookups = {
        index: current,
        notes: current !== undefined ? indexNoteSource(current) : fallbackNotes,
        suggestions: current !== undefined ? indexSuggestions(current) : undefined,
      };
    }
    return lookups;
  };

  const Section = (): ReactElement => {
    useSyncExternalStore(subscribe, () => version);
    const { notes, suggestions } = lookupsFor(index());
    const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
    useEffect(() => flush, []);
    const replace = (id: string, patch: Partial<AutoField>): void =>
      change(fields.map((field) => (field.id === id ? { ...field, ...patch } : field)));
    const toggle = (id: string): void =>
      setOpened((before) => {
        const after = new Set(before);
        if (!after.delete(id)) after.add(id);
        return after;
      });

    return (
      <div className="autofm:flex autofm:flex-col autofm:gap-2">
        <p className="autofm:m-0 autofm:text-sm autofm:text-text-muted">
          Added to a note only when it does not have that property yet. Values can use{" "}
          <code>{"{{date}}"}</code>, <code>{"{{time}}"}</code> and <code>{"{{now}}"}</code>.
        </p>
        <ol className="autofm:m-0 autofm:flex autofm:list-none autofm:flex-col autofm:gap-2 autofm:p-0">
          {fields.map((field, index) => {
            const open = opened.has(field.id);
            const count = field.when.clauses.length;
            const badKey = field.key.trim() !== "" && !isKeyShaped(field.key.trim());
            return (
              <li
                key={field.id}
                className="autofm:flex autofm:flex-col autofm:gap-2 autofm:rounded autofm:border autofm:border-border autofm:p-2"
              >
                <div className="autofm:flex autofm:flex-wrap autofm:items-center autofm:gap-1">
                  {pickers ? (
                    <span className={`autofm:w-36 autofm:min-w-0 ${badKey ? "autofm:[&_input]:border-warning" : ""}`}>
                      <pickers.FmKeySelect
                        value={field.key}
                        placeholder="property"
                        onChange={(key) => replace(field.id, { key })}
                      />
                    </span>
                  ) : (
                    <>
                      <input
                        aria-label="Property"
                        placeholder="property"
                        list={`autofm-keys-${field.id}`}
                        value={field.key}
                        className={`${INPUT} autofm:w-36 ${badKey ? "autofm:border-warning" : ""}`}
                        onChange={(event) => replace(field.id, { key: event.target.value })}
                      />
                      <datalist id={`autofm-keys-${field.id}`}>
                        {(suggestions?.fields() ?? [])
                          .filter((option) => option.field.startsWith("fm."))
                          .map((option) => (
                            <option key={option.field} value={option.field.slice(3)} />
                          ))}
                      </datalist>
                    </>
                  )}
                  <span className="autofm:text-text-muted">:</span>
                  {pickers ? (
                    <span className="autofm:min-w-0 autofm:flex-1 autofm:basis-32">
                      <pickers.FmValueSelect
                        fmKey={field.key.trim()}
                        value={field.value}
                        placeholder="value"
                        onChange={(value) => replace(field.id, { value })}
                      />
                    </span>
                  ) : (
                    <>
                      <input
                        aria-label="Value"
                        placeholder="value"
                        list={`autofm-values-${field.id}`}
                        value={field.value}
                        className={`${INPUT} autofm:flex-1 autofm:basis-32`}
                        onChange={(event) => replace(field.id, { value: event.target.value })}
                      />
                      <datalist id={`autofm-values-${field.id}`}>
                        {(suggestions?.values(`fm.${field.key.trim()}`) ?? []).map((value) => (
                          <option key={value} value={value} />
                        ))}
                      </datalist>
                    </>
                  )}
                  <select
                    aria-label="Added to"
                    value={field.on}
                    className={INPUT}
                    onChange={(event) => replace(field.id, { on: event.target.value === "edit" ? "edit" : "create" })}
                  >
                    <option value="create">new notes</option>
                    <option value="edit">new and edited notes</option>
                  </select>
                  <button
                    type="button"
                    className={BUTTON}
                    aria-expanded={open}
                    onClick={() => toggle(field.id)}
                  >
                    {open ? "▾" : "▸"} {count === 0 ? "every note" : count === 1 ? "1 condition" : `${count} conditions`}
                  </button>
                  <button
                    type="button"
                    className={`${BUTTON} autofm:min-w-[var(--ddd-tap-target)]`}
                    aria-label={`Remove ${field.key.trim() || `property ${index + 1}`}`}
                    onClick={() => change(fields.filter((each) => each.id !== field.id))}
                  >
                    ✕
                  </button>
                </div>
                {badKey && (
                  <p className="autofm:m-0 autofm:text-sm autofm:text-warning">
                    Not added: a property name is letters, digits, spaces, <code>_</code>, <code>-</code> and <code>.</code>.
                  </p>
                )}
                {open && (
                  <div className={CONDITIONS}>
                    <ConditionsEditor
                      value={field.when}
                      onChange={(when) => replace(field.id, { when })}
                      classPrefix="autofm"
                      notes={notes}
                      {...(pickers ?? {})}
                      {...(suggestions !== undefined ? { suggestions } : {})}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        <div>
          <button
            type="button"
            className={BUTTON}
            onClick={() => {
              const field = newField();
              change([...fields, field]);
            }}
          >
            Add property
          </button>
        </div>
      </div>
    );
  };

  const removeSection = addSection({
    id: "auto-fm",
    title: "Automatic properties",
    order: 36,
    description: "Properties added to notes you make or edit, when they do not have them yet.",
    component: Section,
  });
  const close = stop;
  stop = () => {
    close();
    removeSection();
  };
}

let stop: (() => void) | undefined;

export function deactivate(): void {
  stop?.();
  stop = undefined;
}
