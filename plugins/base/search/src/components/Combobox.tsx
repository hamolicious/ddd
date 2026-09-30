/**
 * A text box with a list under it: the part every picker here shares (`NoteSelect`,
 * `FmKeySelect`, `FmValueSelect`). The list is virtual (`_shared/virtual-list.ts`), so a
 * long one costs a screenful. Arrow keys move through it, Enter picks, Escape closes it.
 *
 * What the text means is the picker's: a search for a note, or the value itself. So is
 * what is listed: `useOptions` is a hook, called only while the list is open, so a picker
 * holds its live query or its index reads only then.
 */

import { useEffect, useId, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { useVirtualList } from "../../../_shared/virtual-list.js";

export interface ComboboxOptions<T> {
  readonly options: readonly T[];
  /** Still loading: said instead of "nothing matches". */
  readonly loading?: boolean;
}

export interface ComboboxProps<T> {
  /** The accessible name of the box and the list. */
  readonly label: string;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
  /** What the box shows. */
  readonly text: string;
  readonly onText: (text: string) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** What to list; a hook, called while the list is open. Memoize `options`: a new array each render would never settle. */
  readonly useOptions: () => ComboboxOptions<T>;
  readonly keyOf: (option: T) => string;
  readonly renderOption: (option: T) => ReactNode;
  readonly onPick: (option: T) => void;
  /** When nothing matches; "Nothing matches." by default. */
  readonly empty?: string;
  /**
   * The list always open, under the box in the page's flow rather than over what follows:
   * for a sheet or a panel that is itself the picker. Escape is left to the host (to close
   * the sheet).
   */
  readonly inline?: boolean;
}

/** A row, before it is measured: the tap target. */
const ROW_ESTIMATE = 44;

export function Combobox<T>({
  label,
  placeholder,
  autoFocus = false,
  text,
  onText,
  open,
  onOpenChange,
  useOptions,
  keyOf,
  renderOption,
  onPick,
  empty = "Nothing matches.",
  inline = false,
}: ComboboxProps<T>): ReactElement {
  const listId = useId();
  const shown = inline || open;
  const [active, setActive] = useState(0);
  const [options, setOptions] = useState<readonly T[]>([]);
  const [scrollTo] = useState<{ current: ((index: number) => void) | undefined }>(() => ({ current: undefined }));

  const move = (to: number): void => {
    const next = Math.max(0, Math.min(to, options.length - 1));
    setActive(next);
    scrollTo.current?.(next);
  };

  const pick = (option: T): void => {
    onPick(option);
    onOpenChange(false);
  };

  return (
    <div className="search-combobox search:relative search:min-w-0">
      <input
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        {...(shown && options[active] !== undefined ? { "aria-activedescendant": `${listId}-${active}` } : {})}
        placeholder={placeholder}
        value={text}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        className="search:tap-h search:w-full search:min-w-0 search:rounded search:border search:border-border search:bg-bg search:px-2 search:text-base search:text-text"
        onFocus={() => {
          onOpenChange(true);
          setActive(0);
        }}
        onBlur={() => {
          if (!inline) onOpenChange(false);
        }}
        onChange={(event) => {
          onText(event.target.value);
          onOpenChange(true);
          setActive(0);
          scrollTo.current?.(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            onOpenChange(true);
            move(active + 1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            move(active - 1);
          } else if (event.key === "Enter") {
            const option = options[active];
            if (shown && option !== undefined) {
              event.preventDefault();
              pick(option);
            }
          } else if (event.key === "Escape" && open && !inline) {
            event.preventDefault();
            onOpenChange(false);
            event.currentTarget.blur();
          }
        }}
      />
      {shown && (
        <OptionList
          inline={inline}
          id={listId}
          label={label}
          useOptions={useOptions}
          keyOf={keyOf}
          renderOption={renderOption}
          active={active}
          setActive={setActive}
          pick={pick}
          empty={empty}
          onOptions={setOptions}
          scrollTo={scrollTo}
        />
      )}
    </div>
  );
}

function OptionList<T>({
  inline,
  id,
  label,
  useOptions,
  keyOf,
  renderOption,
  active,
  setActive,
  pick,
  empty,
  onOptions,
  scrollTo,
}: {
  readonly inline: boolean;
  readonly id: string;
  readonly label: string;
  readonly useOptions: () => ComboboxOptions<T>;
  readonly keyOf: (option: T) => string;
  readonly renderOption: (option: T) => ReactNode;
  readonly active: number;
  readonly setActive: (index: number) => void;
  readonly pick: (option: T) => void;
  readonly empty: string;
  readonly onOptions: (options: readonly T[]) => void;
  readonly scrollTo: { current: ((index: number) => void) | undefined };
}): ReactElement {
  const { options, loading = false } = useOptions();
  useEffect(() => onOptions(options), [options]);

  const virtual = useVirtualList({
    count: options.length,
    keyOf: (at) => {
      const option = options[at];
      return option === undefined ? String(at) : keyOf(option);
    },
    estimate: ROW_ESTIMATE,
    clipToWindow: false,
  });
  scrollTo.current = virtual.scrollToIndex;

  return (
    <div
      className={`${inline ? "search:max-h-[50dvh] search:sm:max-h-[22rem]" : "search:absolute search:inset-x-0 search:top-full search:z-20 search:max-h-64 search:shadow-2"} search:mt-1 search:overflow-y-auto search:overscroll-contain search:rounded search:border search:border-border search:bg-bg-raised search:p-1`}
    >
      {options.length === 0 ? (
        <p className="search:m-0 search:px-2 search:py-1.5 search:text-sm search:text-text-muted">
          {loading ? "Loading…" : empty}
        </p>
      ) : (
        <ul
          ref={virtual.listRef}
          id={id}
          role="listbox"
          aria-label={label}
          className="search:m-0 search:list-none search:p-0"
          style={{ paddingTop: virtual.before, paddingBottom: virtual.after }}
        >
          {options.slice(virtual.first, virtual.end).map((option, offset) => {
            const at = virtual.first + offset;
            return (
              <li
                key={keyOf(option)}
                id={`${id}-${at}`}
                data-virtual-index={at}
                role="option"
                aria-selected={at === active}
                className="search:tap-h search:flex search:min-w-0 search:cursor-pointer search:items-center search:gap-2 search:rounded search:px-2 search:aria-selected:bg-accent-subtle"
                // Before the box's blur closes the list.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(at)}
                onClick={() => pick(option)}
              >
                {renderOption(option)}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
