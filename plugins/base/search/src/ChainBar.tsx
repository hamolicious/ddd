import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentType, KeyboardEvent, MutableRefObject, ReactElement, ReactNode, RefObject } from "react";

import type { ContextMenu } from "plugin:context-menu";

import { ConditionsEditor, type FmKeySelectLike, type FmValueSelectLike, type NoteSelectLike } from "../../_shared/conditions-editor.js";
import { newClauseId, type Conditions, type FilterClause, type Suggestions } from "../../_shared/conditions.js";
import type { NoteSource } from "../../_shared/note-picker.js";
import type { SearchSort, SearchSpec } from "./api.js";

import { ANY_STEP, chainSteps, orderWords, sortOptions, sortText } from "./chain.js";
import { codeTokens, type CodeTokenKind } from "./code.js";
import { replaceStep, stepConditions, type FieldOption, type FilterDraft } from "./filter.js";
import { filterOf } from "./spec.js";

export interface EditorDeps {
  readonly notes?: NoteSource;
  readonly NoteSelect?: ComponentType<NoteSelectLike>;
  readonly FmKeySelect?: ComponentType<FmKeySelectLike>;
  readonly FmValueSelect?: ComponentType<FmValueSelectLike>;
  readonly suggestions?: Suggestions;
}

export interface ChainBarProps {
  readonly spec: SearchSpec;
  readonly onSpecChange: (spec: SearchSpec) => void;
  readonly sort: SearchSort;
  readonly onSortChange: (sort: SearchSort) => void;
  readonly extraSorts: readonly FieldOption[];
  readonly menu: Pick<ContextMenu, "open" | "openSheet" | "close">;
  readonly editor: EditorDeps;
  readonly noteTitle: (id: string) => string;
  readonly searchInput?: RefObject<HTMLInputElement>;
  readonly viewPanel?: ReactNode;
  readonly onActions?: (anchor: HTMLElement) => void;
  readonly onSave?: () => void;
  readonly saveLabel?: string;
  readonly code: string;
  readonly onCopyCode: () => void;
  readonly onCopyPlan: () => void;
}

interface Live {
  readonly spec: SearchSpec;
  readonly onSpecChange: (spec: SearchSpec) => void;
  readonly code: string;
}

interface LiveStore {
  get(): Live;
  set(next: Live): void;
  subscribe(listener: () => void): () => void;
}

function liveStore(initial: Live): LiveStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const EDITOR_STYLES =
  "search-step-editor search:flex search:flex-col search:gap-2 search:p-1 search:font-sans search:text-text search:[&_button]:tap-h search:[&_button]:cursor-pointer search:[&_button]:rounded search:[&_button]:border search:[&_button]:border-border search:[&_button]:bg-bg-subtle search:[&_button]:px-2 search:[&_button]:text-inherit search:[&_.search-checkbox]:tap-h search:[&_.search-checkbox]:inline-flex search:[&_.search-checkbox]:cursor-pointer search:[&_.search-checkbox]:items-center search:[&_.search-checkbox]:gap-1 search:[&_.search-checkbox]:whitespace-nowrap search:[&_.search-clause]:flex search:[&_.search-clause]:flex-wrap search:[&_.search-clause]:items-end search:[&_.search-clause]:gap-1.5 search:[&_.search-clause]:rounded search:[&_.search-clause]:border search:[&_.search-clause]:border-transparent search:[&_.search-clause]:p-1 search:[&_.search-clause-invalid]:border-warning search:[&_.search-field]:flex search:[&_.search-field]:flex-col search:[&_.search-field]:gap-0.5 search:[&_.search-field]:text-sm search:[&_.search-field]:text-text-muted search:[&_.search-field_input]:tap-h search:[&_.search-field_input]:rounded search:[&_.search-field_input]:border search:[&_.search-field_input]:border-border search:[&_.search-field_input]:bg-bg search:[&_.search-field_input]:px-2 search:[&_.search-field_input]:text-base search:[&_.search-field_input]:text-text search:[&_.search-field_select]:tap-h search:[&_.search-field_select]:rounded search:[&_.search-field_select]:border search:[&_.search-field_select]:border-border search:[&_.search-field_select]:bg-bg search:[&_.search-field_select]:px-2 search:[&_.search-field_select]:text-base search:[&_.search-field_select]:text-text search:[&_.search-grow]:flex-[1_1_12rem] search:[&_.search-row]:flex search:[&_.search-row]:flex-wrap search:[&_.search-row]:items-end search:[&_.search-row]:gap-2 search:[&_.search-clauses]:m-0 search:[&_.search-clauses]:flex search:[&_.search-clauses]:list-none search:[&_.search-clauses]:flex-col search:[&_.search-clauses]:gap-2 search:[&_.search-clauses]:p-0 search:[&_.search-clause-note]:m-0 search:[&_.search-clause-note]:flex-[1_1_100%] search:[&_.search-clause-note]:text-sm search:[&_.search-clause-note]:text-warning search:[&_.search-icon-button]:min-w-[var(--ddd-tap-target)] search:[&_.search-flags]:flex search:[&_.search-flags]:flex-[1_1_100%] search:[&_.search-flags]:flex-wrap search:[&_.search-flags]:items-center search:[&_.search-flags]:gap-3 search:[&_.search-note-results]:flex search:[&_.search-note-results]:flex-wrap search:[&_.search-note-results]:gap-1";

const KEEP_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

function keepKeys(event: KeyboardEvent<HTMLDivElement>): void {
  if (KEEP_KEYS.has(event.key)) event.stopPropagation();
}

function useLive(store: LiveStore): Live {
  return useSyncExternalStore(store.subscribe, store.get);
}

function withFilter(spec: SearchSpec, filter: FilterDraft): SearchSpec {
  return { ...spec, filter };
}

function WhereEditor({
  store,
  id,
  editor,
  close,
}: {
  readonly store: LiveStore;
  readonly id: string;
  readonly editor: EditorDeps;
  readonly close: () => void;
}): ReactElement {
  const { spec, onSpecChange } = useLive(store);
  const filter = filterOf(spec);
  const any = id === ANY_STEP;
  const step = any ? { combine: filter.combine, clauses: filter.clauses } : stepConditions(filter, id);
  const gone = step === undefined || step.clauses.length === 0 || (any && filter.combine !== "or");
  useEffect(() => {
    if (gone) close();
  }, [gone, close]);
  if (gone) return <div />;

  const change = (next: Conditions & { readonly negate?: boolean }): void => {
    if (any) onSpecChange(withFilter(spec, { ...filter, combine: next.combine, clauses: next.clauses }));
    else onSpecChange(withFilter(spec, replaceStep(filter, id, next)));
  };
  const remove = (): void => {
    change({ combine: step.combine, clauses: [] });
    close();
  };
  const grouped = !any && step.clauses.length > 1;

  return (
    <div className={EDITOR_STYLES} onKeyDown={keepKeys}>
      <ConditionsEditor
        value={step}
        onChange={(next) => change({ ...next, ...(step.negate === true ? { negate: true } : {}) })}
        classPrefix="search"
        {...(editor.notes !== undefined ? { notes: editor.notes } : {})}
        {...(editor.NoteSelect !== undefined ? { NoteSelect: editor.NoteSelect } : {})}
        {...(editor.FmKeySelect !== undefined ? { FmKeySelect: editor.FmKeySelect } : {})}
        {...(editor.FmValueSelect !== undefined ? { FmValueSelect: editor.FmValueSelect } : {})}
        {...(editor.suggestions !== undefined ? { suggestions: editor.suggestions } : {})}
        actions={
          <button type="button" className="search-step-remove search:text-danger!" onClick={remove}>
            Remove step
          </button>
        }
      />
      {grouped && (
        <label className="search-checkbox">
          <input
            type="checkbox"
            checked={step.negate === true}
            onChange={(event) => change({ ...step, negate: event.target.checked })}
          />
          <span>None of these (not)</span>
        </label>
      )}
    </div>
  );
}

const TOKEN_COLORS: Readonly<Record<CodeTokenKind, string | undefined>> = {
  plain: undefined,
  string: "var(--ddd-syntax-string, color-mix(in srgb, var(--ddd-warning) 75%, var(--ddd-text)))",
  number: "var(--ddd-syntax-number, color-mix(in srgb, var(--ddd-danger) 70%, var(--ddd-text)))",
  constant: "var(--ddd-syntax-constant, color-mix(in srgb, var(--ddd-danger) 70%, var(--ddd-text)))",
  function: "var(--ddd-syntax-function, var(--ddd-link))",
  property: "var(--ddd-syntax-property, color-mix(in srgb, var(--ddd-link) 55%, var(--ddd-text)))",
  punctuation: "var(--ddd-syntax-punctuation, var(--ddd-text-muted))",
};

function CodeView({ store, onCopy }: { readonly store: LiveStore; readonly onCopy: () => void }): ReactElement {
  const { code } = useLive(store);
  return (
    <div className={EDITOR_STYLES} onKeyDown={keepKeys}>
      <pre className="search-code-text search:m-0 search:max-h-[60vh] search:overflow-auto search:rounded search:bg-bg search:p-3 search:font-mono search:text-xs search:leading-relaxed search:text-text">
        {codeTokens(code).map((token, index) =>
          TOKEN_COLORS[token.kind] === undefined ? (
            <span key={index}>{token.text}</span>
          ) : (
            <span key={index} style={{ color: TOKEN_COLORS[token.kind] }}>
              {token.text}
            </span>
          ),
        )}
      </pre>
      <div className="search-row">
        <button type="button" onClick={onCopy}>
          Copy code
        </button>
      </div>
    </div>
  );
}

function FromEditor({ store, close }: { readonly store: LiveStore; readonly close: () => void }): ReactElement {
  const { spec, onSpecChange } = useLive(store);
  const filter = filterOf(spec);
  const gone = filter.includeMachine !== true;
  useEffect(() => {
    if (gone) close();
  }, [gone, close]);
  return (
    <div className={EDITOR_STYLES} onKeyDown={keepKeys}>
      <p className="search:m-0 search:text-sm search:text-text-muted">Searching notes.</p>
      <label className="search-checkbox">
        <input
          type="checkbox"
          checked={filter.includeMachine === true}
          onChange={(event) => onSpecChange(withFilter(spec, { ...filter, includeMachine: event.target.checked }))}
        />
        <span title="Documents plugins keep for themselves.">Show machine documents</span>
      </label>
    </div>
  );
}

function Chip({
  verb,
  text,
  ready = true,
  step,
  onOpen,
  active,
}: {
  readonly verb: string;
  readonly text: string;
  readonly ready?: boolean;
  readonly step?: string;
  readonly onOpen: (anchor: HTMLElement) => void;
  readonly active?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      className={`search-step search:inline-flex search:max-w-[24rem] search:shrink-0 search:items-center search:gap-2 search:rounded-lg! search:border search:bg-bg! search:px-3! search:text-sm search:text-text ${ready ? "search:border-border" : "search:border-warning! search:border-dashed!"} ${active === true ? "search:border-accent! search:ring-2 search:ring-accent-subtle" : ""}`}
      aria-haspopup="dialog"
      aria-label={`${verb} ${text}${ready ? "" : ", not finished"}`}
      title={`${verb} ${text}`}
      {...(step !== undefined ? { "data-step": step } : {})}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <span className="search-step-verb search:font-mono search:text-xs search:text-text-muted">{verb}</span>
      <span className="search:truncate">{text}</span>
    </button>
  );
}

function WordsChip({
  verb,
  title,
  label,
  removeLabel,
  placeholder,
  value,
  inputRef,
  onChange,
  onFocus,
  onBlur,
  onRemove,
}: {
  readonly verb: string;
  readonly title: string;
  readonly label: string;
  readonly removeLabel: string;
  readonly placeholder: string;
  readonly value: string;
  readonly inputRef: (element: HTMLInputElement | null) => void;
  readonly onChange: (value: string) => void;
  readonly onFocus: () => void;
  readonly onBlur: (value: string) => void;
  readonly onRemove: () => void;
}): ReactElement {
  return (
    <div
      className={`search-step search-step-words search-step-${verb} search:inline-flex search:min-w-[12rem] search:flex-[1_1_14rem] search:items-center search:gap-2 search:rounded-lg search:border search:border-border search:bg-bg search:px-3 search:compact:flex-none search:compact:min-w-[13rem]`}
      title={title}
    >
      <span className="search-step-verb search:font-mono search:text-xs search:text-text-muted" aria-hidden="true">
        {verb}
      </span>
      <input
        ref={inputRef}
        className="search-step-input search:tap-h search:min-w-0 search:flex-1 search:border-0 search:bg-transparent search:p-0 search:font-mono search:text-sm search:text-text search:outline-none"
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        spellCheck={false}
        autoComplete="off"
        enterKeyHint="search"
        onChange={(event) => onChange(event.target.value)}
        onFocus={onFocus}
        onBlur={(event) => onBlur(event.target.value)}
      />
      <button
        type="button"
        className="search-step-remove-words search:min-h-0! search:shrink-0 search:border-0! search:bg-transparent! search:p-1! search:text-text-muted search:hover:text-text"
        aria-label={removeLabel}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRemove}
      >
        ✕
      </button>
    </div>
  );
}

const ICON =
  "search:inline-flex search:w-[var(--ddd-tap-target)] search:shrink-0 search:items-center search:justify-center search:p-0!";

export function ChainBar({
  spec,
  onSpecChange,
  sort,
  onSortChange,
  extraSorts,
  menu,
  editor,
  noteTitle,
  searchInput,
  viewPanel,
  onActions,
  onSave,
  saveLabel = "Save search",
  code,
  onCopyCode,
  onCopyPlan,
}: ChainBarProps): ReactElement {
  const [store] = useState(() => liveStore({ spec, onSpecChange, code }));
  useLayoutEffect(() => store.set({ spec, onSpecChange, code }), [store, spec, onSpecChange, code]);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [viewOpen, setViewOpen] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [fuzzyOpen, setFuzzyOpen] = useState(false);
  const textInput = useRef<HTMLInputElement | null>(null);
  const fuzzyInput = useRef<HTMLInputElement | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  const filter = filterOf(spec);
  const steps = chainSteps(filter, noteTitle);
  const searching = spec.query.trim() !== "";
  const options = sortOptions(searching, sort, extraSorts);
  const machine = filter.includeMachine === true;
  const sorted = spec.sort !== undefined;
  const fuzzyWords = spec.fuzzy ?? "";
  const showText = spec.query !== "" || textOpen;
  const showFuzzy = fuzzyWords !== "" || fuzzyOpen;
  const hasSteps = steps.length > 0 || machine || searching || sorted || fuzzyWords.trim() !== "";
  const setWords = (field: "query" | "fuzzy", value: string): void => {
    if (field === "query") {
      onSpecChange({ ...spec, query: value });
      return;
    }
    const { fuzzy: _, ...rest } = spec;
    onSpecChange(value === "" ? rest : { ...rest, fuzzy: value });
  };
  const shareInput = (own: MutableRefObject<HTMLInputElement | null>, primary: boolean) => (element: HTMLInputElement | null): void => {
    own.current = element;
    if (primary && searchInput) (searchInput as MutableRefObject<HTMLInputElement | null>).current = element;
  };
  const clear = (): void => {
    setTextOpen(false);
    setFuzzyOpen(false);
    onSpecChange({ query: "", filter: { combine: "and", clauses: [] } });
    addButton.current?.focus();
  };
  const withoutSort = (): SearchSpec => {
    const { sort: _, ...rest } = spec;
    return rest;
  };

  const openStep = (id: string, anchor: HTMLElement): void => {
    setEditing(id);
    menu.openSheet({
      title: id === "from" ? "From" : "Where",
      anchor,
      onClose: () => setEditing(undefined),
      render: (close) =>
        id === "from" ? <FromEditor store={store} close={close} /> : <WhereEditor store={store} id={id} editor={editor} close={close} />,
    });
  };

  useEffect(() => {
    if (pending === undefined) return;
    if (pending === "text" || pending === "fuzzy") {
      setPending(undefined);
      (pending === "text" ? textInput : fuzzyInput).current?.focus();
      return;
    }
    const chip = bar.current?.querySelector<HTMLElement>(`[data-step="${CSS.escape(pending)}"]`);
    setPending(undefined);
    if (!chip) return;
    if (pending === "sort") openSort(chip);
    else openStep(pending, chip);
  });

  const add = (clauses: readonly FilterClause[], combine: "and" | "or" = "and"): void => {
    const id = newClauseId();
    const next =
      filter.combine === "or"
        ? { ...filter, groups: [...(filter.groups ?? []), { id, combine, clauses }] }
        : replaceStep({ ...filter, clauses: [...filter.clauses, { ...(clauses[0] as FilterClause), id }] }, id, { combine, clauses });
    onSpecChange(withFilter(spec, next));
    setPending(id);
  };
  const blank = (): FilterClause => ({ id: newClauseId(), field: "fm.status", op: "eq", kind: "str", value: "" });

  const openAdd = (anchor: HTMLElement): void =>
    menu.open({
      title: "Add a step",
      anchor,
      sections: [
        {
          items: [
            { id: "where", label: "Condition", hint: ".where()", run: () => add([blank()]) },
            {
              id: "inside",
              label: "Inside a note",
              hint: ".where(\"id\", \"child_of\")",
              run: () => add([{ id: newClauseId(), field: "", op: "child_of", kind: "str", value: "", deep: true }]),
            },
            ...(showText
              ? []
              : [
                  {
                    id: "text",
                    label: "Words to find",
                    hint: ".text()",
                    run: () => {
                      setTextOpen(true);
                      setPending("text");
                    },
                  },
                ]),
            ...(showFuzzy
              ? []
              : [
                  {
                    id: "fuzzy",
                    label: "Typo-tolerant words",
                    hint: ".fuzzy(), ranks by match",
                    run: () => {
                      setFuzzyOpen(true);
                      setPending("fuzzy");
                    },
                  },
                ]),
            ...(sorted || showFuzzy
              ? []
              : [
                  {
                    id: "sort",
                    label: "Sort",
                    hint: ".sort()",
                    run: () => {
                      onSortChange(sort);
                      setPending("sort");
                    },
                  },
                ]),
            ...(machine
              ? []
              : [
                  {
                    id: "machine",
                    label: "Include machine notes",
                    hint: ".from()",
                    run: () => onSpecChange(withFilter(spec, { ...filter, includeMachine: true })),
                  },
                ]),
          ],
        },
      ],
    });

  const openSort = (anchor: HTMLElement): void => {
    const words = orderWords(options.find((option) => option.field === sort.field));
    menu.open({
      title: "Sort",
      anchor,
      sections: [
        {
          title: "Sort by",
          items: options.map((option) => ({
            id: option.field,
            label: option.label,
            checked: option.field === sort.field,
            run: () => onSortChange({ field: option.field, direction: sort.direction }),
          })),
        },
        {
          title: "Order",
          items: [
            { id: "desc", label: words.desc, checked: sort.direction === "desc", run: () => onSortChange({ ...sort, direction: "desc" }) },
            { id: "asc", label: words.asc, checked: sort.direction === "asc", run: () => onSortChange({ ...sort, direction: "asc" }) },
          ],
        },
        { items: [{ id: "remove", label: "Remove sort", danger: true, run: () => onSpecChange(withoutSort()) }] },
      ],
    });
  };

  const openMore = (anchor: HTMLElement): void =>
    menu.open({
      title: "More",
      anchor,
      sections: [
        {
          items: [
            {
              id: "code",
              label: "Show as code",
              run: () => menu.openSheet({ title: "As code", anchor, render: () => <CodeView store={store} onCopy={onCopyCode} /> }),
            },
            { id: "copy-code", label: "Copy code", run: onCopyCode },
            { id: "copy-plan", label: "Copy plan JSON", run: onCopyPlan },
            ...(hasSteps
              ? [
                  {
                    id: "clear",
                    label: "Clear the search",
                    run: clear,
                  },
                ]
              : []),
          ],
        },
      ],
    });

  return (
    <div
      ref={bar}
      className="search-chain search:flex search:flex-col search:gap-2 search:rounded search:border search:border-border search:bg-bg-subtle search:p-2"
    >
      <div className="search-chain-row search:flex search:flex-wrap search:items-start search:gap-2">
        <div
          role="group"
          aria-label="Search steps"
          className="search-steps search:flex search:min-w-0 search:flex-[1_1_20rem] search:flex-wrap search:items-center search:gap-1.5 search:compact:flex-nowrap search:compact:overflow-x-auto search:compact:basis-full search:compact:pb-1"
        >
          {machine && (
            <Chip verb="from" text="notes, with machine notes" step="from" active={editing === "from"} onOpen={(anchor) => openStep("from", anchor)} />
          )}
          {showText && (
            <WordsChip
              verb="text"
              title={'Exact words (.text): word, -exclude, "a phrase"'}
              label="Search documents"
              removeLabel="Remove words to find"
              placeholder={'words, -not, "a phrase"'}
              value={spec.query}
              inputRef={shareInput(textInput, true)}
              onChange={(value) => setWords("query", value)}
              onFocus={() => setTextOpen(true)}
              onBlur={(value) => {
                if (value.trim() === "") setTextOpen(false);
              }}
              onRemove={() => {
                setTextOpen(false);
                setWords("query", "");
              }}
            />
          )}
          {steps.map((step) => (
            <Chip
              key={step.id}
              step={step.id}
              verb={step.verb}
              text={step.text}
              ready={step.ready}
              active={editing === step.id}
              onOpen={(anchor) => openStep(step.id, anchor)}
            />
          ))}
          {sorted && !showFuzzy && <Chip verb="sort" text={sortText(sort, options)} step="sort" onOpen={openSort} />}
          {showFuzzy && (
            <WordsChip
              verb="fuzzy"
              title="Typo-tolerant words (.fuzzy): always the last step, it ranks notes by how well they match"
              label="Typo-tolerant words"
              removeLabel="Remove typo-tolerant words"
              placeholder="words, typos are fine"
              value={fuzzyWords}
              inputRef={shareInput(fuzzyInput, !showText)}
              onChange={(value) => setWords("fuzzy", value)}
              onFocus={() => setFuzzyOpen(true)}
              onBlur={(value) => {
                if (value.trim() === "") setFuzzyOpen(false);
              }}
              onRemove={() => {
                setFuzzyOpen(false);
                setWords("fuzzy", "");
              }}
            />
          )}
          <button
            ref={addButton}
            type="button"
            className={`search-step-add ${ICON} search:rounded-lg! search:border-dashed! search:bg-transparent! search:text-text-muted`}
            aria-haspopup="menu"
            aria-label="Add a step"
            title="Add a step"
            onClick={(event) => openAdd(event.currentTarget)}
          >
            +
          </button>
          {hasSteps && (
            <button
              type="button"
              className="search-clear search:shrink-0 search:rounded-lg! search:border-transparent! search:bg-transparent! search:px-2! search:text-sm search:text-text-muted search:hover:text-text"
              title="Remove every step and start from scratch"
              onClick={clear}
            >
              Clear
            </button>
          )}
        </div>
        <div className="search-chain-tools search:ml-auto search:flex search:shrink-0 search:gap-1.5">
          {viewPanel !== undefined && (
            <button
              type="button"
              className={`search-view-toggle ${ICON} search:aria-expanded:border-accent! search:aria-expanded:bg-accent-subtle!`}
              aria-expanded={viewOpen}
              aria-label="View"
              title="View"
              onClick={() => setViewOpen((open) => !open)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="search:size-[1.15em]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M3 9h18M9 9v11M15 9v11" />
              </svg>
            </button>
          )}
          {onActions && (
            <button
              type="button"
              className={`search-actions ${ICON}`}
              aria-haspopup="menu"
              aria-label="Actions for these results"
              title="Actions"
              onClick={(event) => onActions(event.currentTarget)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="search:size-[1.15em]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 3v7h6l-8 11v-7H5z" />
              </svg>
            </button>
          )}
          {onSave && (
            <button
              type="button"
              className="search-save search:border-accent! search:bg-accent! search:px-3! search:text-sm search:font-medium search:text-accent-text!"
              onClick={onSave}
            >
              {saveLabel}
            </button>
          )}
          <button
            type="button"
            className={`search-more ${ICON} search:text-lg`}
            aria-haspopup="menu"
            aria-label="More"
            title="More"
            onClick={(event) => openMore(event.currentTarget)}
          >
            ⋯
          </button>
        </div>
      </div>
      {viewOpen && viewPanel !== undefined && (
        <div className={`search-view-panel ${EDITOR_STYLES} search:border-t search:border-border search:pt-2`}>{viewPanel}</div>
      )}
    </div>
  );
}
