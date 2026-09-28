/**
 * The main view: the toolbar, the graph and the draft bar. On a wide screen the inspector
 * is the altbar panel; on a phone it is a bottom sheet opened from a selection or the ☰
 * button (§7). Read-only states are pills: offline, no core, no routes.
 */

import { useEffect, useRef } from "react";
import type { ReactElement } from "react";

import { Graph } from "./Graph.js";
import { useEditor } from "./hooks.js";
import { Pill } from "./Inspector.js";
import type { EditorStore, Selection } from "./store.js";

export interface WiringViewProps {
  readonly store: EditorStore;
  readonly isAdmin: boolean;
  readonly compact: boolean;
  readonly onSelect: (selection: Selection) => void;
  readonly onConnect: (from: string, to: string) => void;
  readonly onApply: () => void;
  /** Phone: open the inspector sheet. */
  readonly onInspect: () => void;
}

const BTN = "wiring:tap-h wiring:inline-flex wiring:cursor-pointer wiring:items-center wiring:justify-center wiring:gap-1 wiring:rounded wiring:border wiring:border-border wiring:bg-bg-raised wiring:px-2 wiring:py-0.5 wiring:text-xs wiring:text-text wiring:hover:border-border-strong wiring:disabled:cursor-default wiring:disabled:opacity-50";
const CHIP = "wiring-chip wiring:tap-h wiring:inline-flex wiring:cursor-pointer wiring:items-center wiring:gap-1 wiring:rounded-full wiring:border wiring:border-border wiring:bg-transparent wiring:px-2 wiring:py-0 wiring:text-xs wiring:text-text-muted wiring:aria-pressed:border-border-strong wiring:aria-pressed:text-text";

export function WiringView({ store, isAdmin, compact, onSelect, onConnect, onApply, onInspect }: WiringViewProps): ReactElement {
  const state = useEditor(store);
  const root = useRef<HTMLDivElement>(null);

  // Delete cuts the selected wire; Escape clears the selection. Scoped to the view.
  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      const tag = (event.target as HTMLElement | null)?.tagName ?? "";
      if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
      const selection = store.state.selection;
      if ((event.key === "Delete" || event.key === "Backspace") && selection?.kind === "wire") {
        event.preventDefault();
        store.cutWire(selection.key);
      } else if (event.key === "Escape") onSelect(undefined);
    };
    element.addEventListener("keydown", onKey);
    return () => element.removeEventListener("keydown", onKey);
  }, [store, onSelect]);

  if (!isAdmin) {
    return (
      <section className="wiring:flex wiring:flex-col wiring:gap-3 wiring:p-4 wiring:font-sans wiring:text-text" aria-labelledby="wiring-heading">
        <h2 id="wiring-heading" className="wiring:m-0">
          Wiring
        </h2>
        <p className="wiring:m-0 wiring:text-sm wiring:text-text-muted">You are not an administrator. Ask one to promote your account.</p>
      </section>
    );
  }

  const canvasSize = (): readonly [number, number] => {
    const element = root.current?.querySelector(".wiring-canvas");
    return element ? [element.clientWidth, element.clientHeight] : [800, 600];
  };
  const kinds = state.kinds;
  const changes = state.summary?.rows.length ?? 0;

  return (
    <div ref={root} className="wiring-view wiring:flex wiring:h-full wiring:w-full wiring:flex-col wiring:bg-bg wiring:font-sans wiring:text-text" tabIndex={-1}>
      <div className="wiring-toolbar wiring:flex wiring:flex-wrap wiring:items-center wiring:gap-1.5 wiring:border-b wiring:border-border wiring:px-2 wiring:py-1" role="toolbar" aria-label="Wiring controls">
        <span className="wiring:inline-flex wiring:gap-1" role="group" aria-label="Show">
          {(["service", "slot", "event"] as const).map((kind) => (
            <button key={kind} type="button" className={CHIP} aria-pressed={kinds[kind]} onClick={() => store.setKinds({ ...kinds, [kind]: !kinds[kind] })}>
              <span className={`wiring-pd ${kind}`} aria-hidden="true" />
              {kind}
            </button>
          ))}
        </span>
        <select
          className="wiring:tap-h wiring:max-w-[12rem] wiring:rounded wiring:border wiring:border-border wiring:bg-bg wiring:px-1 wiring:text-xs wiring:text-text"
          aria-label="Protocol"
          value={state.protocolFilter}
          onChange={(event) => store.setProtocolFilter(event.target.value)}
        >
          <option value="">all protocols</option>
          {state.protocols.ids().map((id) => (
            <option key={id} value={id}>
              {id} · {state.protocols.kindOf(id)}
            </option>
          ))}
        </select>
        <span className="wiring:inline-flex wiring:gap-1">
          <button type="button" className={BTN} title="Fit" aria-label="Fit" onClick={() => store.fit(...canvasSize())}>
            ⤢
          </button>
          <button
            type="button"
            className={BTN}
            title="Tidy: columns by dependants"
            aria-label="Tidy"
            onClick={() => {
              store.tidy();
              store.fit(...canvasSize());
            }}
          >
            ⊞
          </button>
          <button type="button" className={BTN} title="Zoom out" aria-label="Zoom out" onClick={() => zoomCentre(store, root.current, 1 / 1.2)}>
            −
          </button>
          <button type="button" className={BTN} title="Zoom in" aria-label="Zoom in" onClick={() => zoomCentre(store, root.current, 1.2)}>
            +
          </button>
          <button type="button" className={BTN} title="Reset to automatic wiring" aria-label="Reset to automatic" disabled={!!state.readOnly} onClick={() => store.resetToAutomatic()}>
            ↺
          </button>
        </span>
        <span className="wiring:ml-auto wiring:inline-flex wiring:flex-wrap wiring:items-center wiring:gap-1">
          {state.phase === "loading" && <Pill tone="muted">loading</Pill>}
          {state.phase === "error" && (
            <Pill tone="err" title={state.error}>
              error
            </Pill>
          )}
          {state.readOnly === "offline" && <Pill tone="err">offline · read-only</Pill>}
          {state.readOnly === "core" && (
            <Pill tone="err" title="the Wasm core did not load; previews and drafts need it">
              read-only · no core
            </Pill>
          )}
          {state.readOnly === "routes" && (
            <Pill tone="err" title="the server has no wiring routes">
              read-only · no routes
            </Pill>
          )}
          {state.phase === "ready" && (
            <Pill tone={state.dirty ? "draft" : "live"} title={state.dirty ? `draft on v${state.live.version}` : "the live wiring"}>
              {state.dirty ? "draft" : "live"} v{state.live.version}
            </Pill>
          )}
          {state.liveMoved && (
            <Pill tone="warn" title={state.liveMoved.changed.join("\n") || "the live wiring changed"}>
              live moved v{state.liveMoved.from} → v{state.liveMoved.to}
            </Pill>
          )}
          {compact && (
            <button type="button" className={BTN} aria-label="Inspector" title="Inspector" onClick={onInspect}>
              ☰{changes > 0 && <Pill tone="warn">{changes}</Pill>}
            </button>
          )}
        </span>
      </div>
      <div className="wiring:relative wiring:min-h-0 wiring:flex-1">
        {state.phase === "error" && !state.graph.nodes.length ? (
          <p role="alert" className="wiring:m-4 wiring:text-sm wiring:text-danger">
            {state.error}
          </p>
        ) : (
          <Graph store={store} onSelect={onSelect} onConnect={onConnect} />
        )}
        {state.notice && (
          <div role="status" aria-live="polite" className={`wiring-toast${state.notice.bad ? " bad" : ""}`}>
            {state.notice.text}
          </div>
        )}
        <div className="wiring-legend" aria-hidden="true">
          <span>
            <i className="wiring-pd service" /> service
          </span>
          <span>
            <i className="wiring-pd slot" /> slot
          </span>
          <span>
            <i className="wiring-pd event" /> event
          </span>
          <span>
            <i className="wiring-line byshape" /> by shape
          </span>
        </div>
      </div>
      {state.dirty && (
        <div className="wiring-draftbar wiring:flex wiring:flex-wrap wiring:items-center wiring:gap-2 wiring:border-t wiring:border-border wiring:px-2 wiring:py-1" role="region" aria-label="Draft">
          <Pill tone="draft">draft</Pill>
          <Pill tone="warn">{changes} change{changes === 1 ? "" : "s"}</Pill>
          <Pill tone="muted">on v{state.live.version}</Pill>
          {state.draftAction === "rollback" && <Pill tone="fit">rollback v{state.draftFrom}</Pill>}
          {state.summary && state.summary.addedErrors > 0 && <Pill tone="err">+{state.summary.addedErrors} errors</Pill>}
          {state.summary?.stopsEditor && <Pill tone="err">stops editor</Pill>}
          {state.summary && state.summary.cold.length > 0 && (
            <Pill tone="warn" title={state.summary.cold.join(", ")}>
              reload · {state.summary.cold.length}
            </Pill>
          )}
          <span className="wiring:ml-auto wiring:inline-flex wiring:gap-2">
            <button type="button" className={BTN} disabled={state.busy} onClick={() => store.discard()}>
              Discard
            </button>
            <button type="button" className={`${BTN} wiring:border-accent wiring:bg-accent wiring:text-accent-text`} disabled={state.busy || !!state.readOnly} onClick={onApply}>
              Apply
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

function zoomCentre(store: EditorStore, root: HTMLDivElement | null, factor: number): void {
  const element = root?.querySelector(".wiring-canvas");
  if (!element) return;
  store.zoom(factor, element.clientWidth / 2, element.clientHeight / 2);
}
