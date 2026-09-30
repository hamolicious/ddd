/**
 * The board's settings, under the view picker: which field's values are the columns, which
 * one's (if any) are the swimlanes (`lanes.ts`), and
 * whether the board keeps its own order within them — each card's place, saved in its own
 * `%%% kanban` section, not a property — or follows the search's sort, in which case cards
 * change column but a column cannot be rearranged. Each column's own settings live on the column (its ⚙, `ColumnEditor.tsx`).
 *
 * **What a card shows** is a list here too (`card.ts`): the title, any property, the note's
 * text, top to bottom — each moved with ↑ ↓, hidden with the eye, removed with × (the title
 * can only be hidden). The last item shown cannot be hidden or removed: a card always says
 * something. Every property in the list is also a filter above the board (`Board.tsx`).
 */

import type { ReactElement } from "react";

import type { ViewSettingsProps } from "../../_shared/saved-view-mode.js";

import { FieldSelect } from "../../_shared/field-select.js";

import { itemKey, type CardItem } from "./card.js";
import { kanbanOptions, withKanban, writableField, writableGroup } from "./layout.js";

const SMALL = "kanban:inline-flex kanban:size-8 kanban:min-h-0! kanban:items-center kanban:justify-center kanban:p-0! kanban:text-text-muted kanban:hover:text-text kanban:disabled:opacity-40";

function itemName(item: CardItem): string {
  return item.kind === "title" ? "Title" : item.kind === "content" ? "Text" : item.field.slice("fm.".length);
}

const FIELD = "kanban:flex kanban:flex-col kanban:gap-0.5 kanban:text-sm kanban:text-text-muted kanban:[&_select]:tap-h kanban:[&_select]:rounded kanban:[&_select]:border kanban:[&_select]:border-border kanban:[&_select]:bg-bg kanban:[&_select]:px-2 kanban:[&_select]:text-base kanban:[&_select]:text-text";

export function KanbanSettings({ options, onOptionsChange, fields }: ViewSettingsProps): ReactElement {
  const settings = kanbanOptions(options);
  const card = settings.card;
  const setCard = (next: readonly CardItem[]): void => onOptionsChange(withKanban({ ...settings, card: next }, options));
  const shown = card.filter((item) => item.hidden !== true).length;
  const move = (index: number, by: number): void => {
    const next = [...card];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(index + by, 0, item);
    setCard(next);
  };
  const present = new Set(card.map(itemKey));
  const addable = [
    ...(present.has("content") ? [] : [{ key: "content", label: "Text (the note's words)" }]),
    ...fields
      .filter((field) => /^fm\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(field.field) && !present.has(field.field))
      .map((field) => ({ key: field.field, label: field.field.slice("fm.".length) })),
  ];

  return (
    <div className="kanban-settings kanban:flex kanban:flex-col kanban:gap-3">
    <div className="kanban:flex kanban:flex-wrap kanban:items-start kanban:gap-3">
      <div className="kanban:flex kanban:flex-col kanban:gap-0.5">
        <FieldSelect
          className={FIELD}
          label="Columns from"
          value={settings.group}
          onChange={(group) => onOptionsChange(withKanban({ ...settings, group }, options))}
          fields={fields}
        />
        {!writableGroup(settings.group) && (
          <span className="kanban:max-w-[16rem] kanban:text-xs kanban:text-warning">Cards cannot be moved: only a top-level property can be set.</span>
        )}
      </div>
      <div className="kanban:flex kanban:flex-col kanban:gap-0.5">
        <FieldSelect
          className={FIELD}
          label="Swimlanes by"
          value={settings.lanes}
          onChange={(lanes) => onOptionsChange(withKanban({ ...settings, lanes }, options))}
          fields={fields}
          none="No swimlanes"
        />
        {settings.lanes !== "" && !writableField(settings.lanes) && (
          <span className="kanban:max-w-[16rem] kanban:text-xs kanban:text-warning">Cards cannot change swimlane: only a top-level property can be set.</span>
        )}
      </div>
      <div className="kanban:flex kanban:flex-col kanban:gap-0.5">
        <label className={FIELD}>
          <span>Order within columns</span>
          <select
            value={settings.order ? "board" : "search"}
            onChange={(event) => onOptionsChange(withKanban({ ...settings, order: event.target.value === "board" }, options))}
          >
            <option value="board">Board order (drag to arrange)</option>
            <option value="search">The search's sort</option>
          </select>
        </label>
        <span className="kanban:max-w-[16rem] kanban:text-xs kanban:text-text-muted">
          {settings.order ? "Dragging a card saves its place with the card." : "Cards follow the search's sort; dragging only changes the column."}
        </span>
      </div>
    </div>

    <fieldset className="kanban:m-0 kanban:flex kanban:flex-col kanban:gap-1 kanban:border-0 kanban:p-0">
      <legend className="kanban:mb-1 kanban:p-0 kanban:text-sm kanban:text-text-muted">Cards show, top to bottom</legend>
      <ol className="kanban:m-0 kanban:flex kanban:list-none kanban:flex-col kanban:gap-0.5 kanban:p-0">
        {card.map((item, index) => {
          const hidden = item.hidden === true;
          const last = !hidden && shown === 1;
          return (
            <li key={itemKey(item)} className="kanban:flex kanban:items-center kanban:gap-1 kanban:text-sm">
              <span className={`kanban:min-w-0 kanban:flex-1 kanban:truncate ${hidden ? "kanban:text-text-muted kanban:line-through" : ""}`}>{itemName(item)}</span>
              <button
                type="button"
                className={SMALL}
                aria-pressed={!hidden}
                aria-label={hidden ? `Show ${itemName(item)}` : `Hide ${itemName(item)}`}
                title={last ? "A card must show something" : hidden ? "Show" : "Hide"}
                disabled={last}
                onClick={() => setCard(card.map((candidate, at) => (at === index ? { ...candidate, hidden: !hidden } : candidate)))}
              >
                {hidden ? "◌" : "●"}
              </button>
              <button type="button" className={SMALL} aria-label={`Move ${itemName(item)} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                ↑
              </button>
              <button type="button" className={SMALL} aria-label={`Move ${itemName(item)} down`} disabled={index === card.length - 1} onClick={() => move(index, 1)}>
                ↓
              </button>
              <button
                type="button"
                className={`${SMALL} kanban:hover:text-danger`}
                aria-label={`Remove ${itemName(item)}`}
                title={item.kind === "title" ? "The title can be hidden, not removed" : last ? "A card must show something" : "Remove"}
                disabled={item.kind === "title" || last}
                onClick={() => setCard(card.filter((_, at) => at !== index))}
              >
                ×
              </button>
            </li>
          );
        })}
      </ol>
      {addable.length > 0 && (
        <label className={`${FIELD} kanban:max-w-[16rem]`}>
          <span className="kanban:sr-only">Add to cards</span>
          <select
            value=""
            onChange={(event) => {
              const key = event.target.value;
              if (key === "") return;
              setCard([...card, key === "content" ? { kind: "content" } : { kind: "field", field: key }]);
            }}
          >
            <option value="">Add to cards…</option>
            {addable.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </fieldset>
    </div>
  );
}
