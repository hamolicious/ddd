import type { ReactElement } from "react";

import type { Icons } from "@protocols/lm/icons";

import { ConditionsEditor, type NoteLookup } from "../../_shared/conditions-editor.js";
import type { Suggestions } from "../../_shared/conditions-index.js";
import { newClauseId } from "../../_shared/conditions.js";

import { newRuleId, resolveStyle, textOn, type FolderStyle, type Rule } from "./styles.js";

export interface RulesProps {
  readonly rules: readonly Rule[];
  readonly onChange: (rules: readonly Rule[]) => void;
  /** For each rule's preview: what a field it leaves unset shows. */
  readonly defaults: FolderStyle;
  readonly icons: Pick<Icons, "Icon" | "Picker"> | undefined;
  readonly notes: NoteLookup;
  /** Properties and values to offer, from the indexer. */
  readonly suggestions?: Suggestions;
  /** Opens the colour and icon editor for `rule` beside `anchor`. */
  readonly openLook: (rule: Rule, anchor: HTMLElement) => void;
}

const BUTTON =
  "folderstyle:tap-h folderstyle:cursor-pointer folderstyle:rounded folderstyle:border folderstyle:border-border-strong folderstyle:bg-bg-raised folderstyle:px-1.5 folderstyle:font-sans folderstyle:text-text folderstyle:disabled:cursor-default folderstyle:disabled:opacity-50";

/**
 * The conditions are styled here, for `ConditionsEditor` carries only plain classes
 * (`folderstyle-clause` and so on): see its header.
 */
const CONDITIONS =
  "folderstyle:flex folderstyle:flex-col folderstyle:gap-2 " +
  "folderstyle:[&_button]:tap-h folderstyle:[&_button]:cursor-pointer folderstyle:[&_button]:rounded folderstyle:[&_button]:border folderstyle:[&_button]:border-border-strong folderstyle:[&_button]:bg-bg-raised folderstyle:[&_button]:px-1.5 folderstyle:[&_button]:text-text " +
  "folderstyle:[&_.folderstyle-row]:flex folderstyle:[&_.folderstyle-row]:flex-wrap folderstyle:[&_.folderstyle-row]:items-end folderstyle:[&_.folderstyle-row]:gap-2 " +
  "folderstyle:[&_.folderstyle-clauses]:m-0 folderstyle:[&_.folderstyle-clauses]:flex folderstyle:[&_.folderstyle-clauses]:list-none folderstyle:[&_.folderstyle-clauses]:flex-col folderstyle:[&_.folderstyle-clauses]:gap-2 folderstyle:[&_.folderstyle-clauses]:p-0 " +
  "folderstyle:[&_.folderstyle-clause]:flex folderstyle:[&_.folderstyle-clause]:flex-wrap folderstyle:[&_.folderstyle-clause]:items-end folderstyle:[&_.folderstyle-clause]:gap-1.5 folderstyle:[&_.folderstyle-clause]:rounded folderstyle:[&_.folderstyle-clause]:border folderstyle:[&_.folderstyle-clause]:border-transparent folderstyle:[&_.folderstyle-clause]:p-1 " +
  "folderstyle:[&_.folderstyle-clause-invalid]:border-warning " +
  "folderstyle:[&_.folderstyle-clause-note]:m-0 folderstyle:[&_.folderstyle-clause-note]:flex-[1_1_100%] folderstyle:[&_.folderstyle-clause-note]:text-sm folderstyle:[&_.folderstyle-clause-note]:text-warning " +
  "folderstyle:[&_.folderstyle-field]:flex folderstyle:[&_.folderstyle-field]:flex-col folderstyle:[&_.folderstyle-field]:gap-0.5 folderstyle:[&_.folderstyle-field]:text-sm folderstyle:[&_.folderstyle-field]:text-text-muted " +
  "folderstyle:[&_.folderstyle-field_input]:tap-h folderstyle:[&_.folderstyle-field_input]:rounded folderstyle:[&_.folderstyle-field_input]:border folderstyle:[&_.folderstyle-field_input]:border-border folderstyle:[&_.folderstyle-field_input]:bg-bg folderstyle:[&_.folderstyle-field_input]:px-2 folderstyle:[&_.folderstyle-field_input]:text-base folderstyle:[&_.folderstyle-field_input]:text-text " +
  "folderstyle:[&_.folderstyle-field_select]:tap-h folderstyle:[&_.folderstyle-field_select]:rounded folderstyle:[&_.folderstyle-field_select]:border folderstyle:[&_.folderstyle-field_select]:border-border folderstyle:[&_.folderstyle-field_select]:bg-bg folderstyle:[&_.folderstyle-field_select]:px-2 folderstyle:[&_.folderstyle-field_select]:text-base folderstyle:[&_.folderstyle-field_select]:text-text " +
  "folderstyle:[&_.folderstyle-grow]:flex-[1_1_12rem] folderstyle:compact:[&_.folderstyle-grow]:basis-full " +
  "folderstyle:[&_.folderstyle-checkbox]:tap-h folderstyle:[&_.folderstyle-checkbox]:inline-flex folderstyle:[&_.folderstyle-checkbox]:cursor-pointer folderstyle:[&_.folderstyle-checkbox]:items-center folderstyle:[&_.folderstyle-checkbox]:gap-1 folderstyle:[&_.folderstyle-checkbox]:whitespace-nowrap " +
  "folderstyle:[&_.folderstyle-icon-button]:min-w-[var(--lm-tap-target)] " +
  "folderstyle:[&_.folderstyle-note-results]:flex folderstyle:[&_.folderstyle-note-results]:flex-wrap folderstyle:[&_.folderstyle-note-results]:gap-1";

/** The rules, in order: the first a note matches wins, field by field. */
export function Rules({ rules, onChange, defaults, icons, notes, suggestions, openLook }: RulesProps): ReactElement {
  const replace = (id: string, change: Partial<Rule>): void =>
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...change } : rule)));
  const move = (index: number, by: -1 | 1): void => {
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    if (rule === undefined) return;
    next.splice(index + by, 0, rule);
    onChange(next);
  };

  return (
    <section className="folderstyle:flex folderstyle:flex-col folderstyle:gap-2">
      <h3 className="folderstyle:m-0 folderstyle:text-base">Rules</h3>
      <p className="folderstyle:m-0 folderstyle:text-sm folderstyle:text-text-muted">
        Notes that match a rule take its color and icon. The first matching rule wins. A color or icon set on
        the note itself is never changed.
      </p>

      <ol className="folderstyle:m-0 folderstyle:flex folderstyle:list-none folderstyle:flex-col folderstyle:gap-2 folderstyle:p-0">
        {rules.map((rule, index) => {
          const shown = resolveStyle(rule.style, defaults);
          return (
            <li
              key={rule.id}
              className="folder-style-rule folderstyle:flex folderstyle:flex-col folderstyle:gap-2 folderstyle:rounded folderstyle:border folderstyle:border-border folderstyle:p-2"
            >
              <div className="folderstyle:flex folderstyle:flex-wrap folderstyle:items-center folderstyle:gap-1">
                <button
                  type="button"
                  className={BUTTON}
                  title="Color and icon"
                  onClick={(event) => openLook(rule, event.currentTarget)}
                >
                  <span
                    className={`folderstyle:inline-flex folderstyle:items-center folderstyle:gap-1 ${shown?.background !== undefined ? "folderstyle:rounded folderstyle:px-1.5" : ""}`}
                    style={
                      shown?.background !== undefined
                        ? { background: shown.background, color: textOn(shown.background) }
                        : undefined
                    }
                  >
                    {icons !== undefined && shown?.icon !== undefined && <icons.Icon name={shown.icon} size="1.05em" />}
                    <span>Rule {index + 1}</span>
                  </span>
                </button>
                <span className="folderstyle:flex-1" />
                <button type="button" className={BUTTON} aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  className={BUTTON}
                  aria-label="Move down"
                  disabled={index === rules.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className={BUTTON}
                  aria-label={`Remove rule ${index + 1}`}
                  onClick={() => onChange(rules.filter((each) => each.id !== rule.id))}
                >
                  ✕
                </button>
              </div>
              <div className={CONDITIONS}>
                <ConditionsEditor
                  value={rule.when}
                  onChange={(when) => replace(rule.id, { when })}
                  classPrefix="folderstyle"
                  notes={notes}
                  {...(suggestions !== undefined ? { suggestions } : {})}
                />
              </div>
              {rule.when.clauses.length === 0 && (
                <p className="folderstyle:m-0 folderstyle:text-sm folderstyle:text-text-muted">
                  Add a condition: a rule without one matches nothing.
                </p>
              )}
            </li>
          );
        })}
      </ol>

      <div>
        <button
          type="button"
          className={BUTTON}
          onClick={() =>
            onChange([
              ...rules,
              {
                id: newRuleId(),
                when: {
                  combine: "and",
                  clauses: [{ id: newClauseId(), field: "fm.tags", op: "contains", value: "", kind: "str" }],
                },
                style: {},
              },
            ])
          }
        >
          Add rule
        </button>
      </div>
    </section>
  );
}
