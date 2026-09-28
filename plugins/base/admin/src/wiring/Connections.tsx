/**
 * The plugin list's wiring (PLUGIN-PROTOCOLS §6, §6a, §6b, §6c): a Connections panel per
 * expanded plugin, and a draft bar for the Plugins tab. Both read and edit the Wiring
 * tab's own store, so an edit here is an edit in the graph's draft and the other way
 * round. The rows and their options come from `connections.ts`; this file draws them.
 *
 * Labels, pills and tooltips; no prose. Read-only (offline, no core, no routes) disables
 * every control and says why in a pill, as the graph does.
 */

import { useMemo } from "react";
import type { ChangeEvent, ReactElement } from "react";

import type { PortCandidate } from "@kernel";

import type { SharedWiring } from "../hooks.js";
import { AUTOMATIC, NONE, connectionRows, type ConnectionRow, type Option, type Peer } from "./connections.js";
import { useEditor } from "./hooks.js";
import { Pill } from "./Inspector.js";
import type { EditorState } from "./store.js";

const BTN = "admin:tap-h admin:inline-flex admin:cursor-pointer admin:items-center admin:justify-center admin:gap-1 admin:rounded admin:border admin:border-border admin:bg-bg-raised admin:px-2 admin:py-0.5 admin:text-xs admin:text-text admin:hover:border-border-strong admin:disabled:cursor-default admin:disabled:opacity-50";
const SM = `${BTN} admin:min-h-0 admin:px-1.5 admin:py-0 admin:text-[0.7rem] admin:touch:min-h-[var(--lm-tap-target)]`;
const DANGER = "admin:border-danger admin:text-danger";
const PRIMARY = "admin:border-accent admin:bg-accent admin:text-accent-text";
const CAP = "admin:m-0 admin:text-[0.62rem] admin:font-semibold admin:uppercase admin:tracking-wide admin:text-text-muted";
const MONO = "admin:font-mono admin:text-[0.72rem]";
const SELECT = "admin:tap-h admin:w-auto admin:min-w-0 admin:max-w-[20rem] admin:rounded admin:border admin:border-border admin:bg-bg admin:px-1 admin:text-xs admin:text-text admin:disabled:opacity-50 admin:compact:w-full admin:compact:max-w-none";

/** Why the store cannot change anything, as the graph's toolbar says it. */
export function ReadOnlyPill({ state }: { readonly state: EditorState }): ReactElement | null {
  switch (state.readOnly) {
    case "offline":
      return <Pill tone="err">offline · read-only</Pill>;
    case "core":
      return (
        <Pill tone="err" title="the Wasm core did not load; previews and drafts need it">
          read-only · no core
        </Pill>
      );
    case "routes":
      return (
        <Pill tone="err" title="the server has no wiring routes">
          read-only · no routes
        </Pill>
      );
    default:
      return null;
  }
}

export function ConnectionsPanel({ shared, plugin }: { readonly shared: SharedWiring; readonly plugin: string }): ReactElement {
  const { store } = shared;
  const state = useEditor(store);
  const node = state.graph.byId.get(plugin);
  // One resolver call per port, again only when the draft or the plugin set moves.
  const candidates = useMemo(() => {
    const out: Record<string, readonly PortCandidate[]> = {};
    for (const port of node?.ports ?? []) out[port.key] = store.candidates(port.key, port.dir);
    return out;
  }, [store, node, state.draft, state.plugins, state.core]);
  const rows = useMemo(
    () => connectionRows({ plugin, graph: state.graph, resolution: state.resolution, draft: state.draft, candidates }),
    [plugin, state.graph, state.resolution, state.draft, candidates],
  );
  const off = !!state.readOnly || state.busy || state.phase !== "ready";

  return (
    <section className="wiring-connections admin:flex admin:flex-col admin:gap-2" aria-label={`Connections of ${plugin}`}>
      <h5 className="admin:m-0 admin:flex admin:flex-wrap admin:items-center admin:gap-2 admin:text-xs admin:font-semibold admin:uppercase admin:tracking-[0.04em] admin:text-text-muted">
        Connections
        {state.phase === "loading" && <Pill tone="muted">loading</Pill>}
        {state.phase === "error" && (
          <Pill tone="err" title={state.error}>
            error
          </Pill>
        )}
        <ReadOnlyPill state={state} />
        {state.dirty && <Pill tone="draft">draft</Pill>}
      </h5>
      {state.phase === "ready" && !node ? (
        <span className="admin:text-xs admin:text-text-muted">none</span>
      ) : (
        <>
          <Group title="Uses" rows={rows.uses} shared={shared} off={off} />
          <Group title="Used by" rows={rows.usedBy} shared={shared} off={off} />
        </>
      )}
    </section>
  );
}

function Group({ title, rows, shared, off }: { readonly title: string; readonly rows: readonly ConnectionRow[]; readonly shared: SharedWiring; readonly off: boolean }): ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <div className="admin:flex admin:flex-col admin:gap-1">
      <h6 className={CAP}>{title}</h6>
      <ul className="admin:m-0 admin:flex admin:list-none admin:flex-col admin:p-0">
        {rows.map((row) => (
          <PortRow key={row.key} row={row} shared={shared} off={off} />
        ))}
      </ul>
    </div>
  );
}

function PortRow({ row, shared, off }: { readonly row: ConnectionRow; readonly shared: SharedWiring; readonly off: boolean }): ReactElement {
  return (
    <li
      data-port={row.key}
      className="admin:grid admin:grid-cols-[minmax(9rem,16rem)_1fr] admin:items-start admin:gap-x-3 admin:gap-y-1 admin:border-b admin:border-border admin:py-1.5 admin:last:border-b-0 admin:compact:grid-cols-1"
    >
      <div className="admin:flex admin:min-w-0 admin:flex-wrap admin:items-center admin:gap-1">
        <span className={`${MONO} admin:break-all`}>
          <b className="admin:font-semibold">{row.name}</b>
          <span className="admin:text-text-muted"> · {row.protocol}</span>
        </span>
        {row.pills.map((pill) => (
          <Pill key={`${pill.tone}:${pill.text}`} tone={pill.tone} title={pill.title}>
            {pill.text}
          </Pill>
        ))}
      </div>
      <div className="admin:flex admin:min-w-0 admin:flex-col admin:gap-1">
        {row.choices ? (
          <ServiceChoice row={row} shared={shared} off={off} />
        ) : (
          <>
            {row.seats && <Seats row={row} shared={shared} off={off} />}
            {row.peers && <Peers row={row} peers={row.peers} shared={shared} off={off} />}
            {row.add && <AddSelect row={row} options={row.add} shared={shared} off={off} />}
          </>
        )}
      </div>
    </li>
  );
}

function ServiceChoice({ row, shared, off }: { readonly row: ConnectionRow; readonly shared: SharedWiring; readonly off: boolean }): ReactElement {
  const onChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const value = event.target.value;
    shared.store.bind(row.key, value === AUTOMATIC ? undefined : value === NONE ? null : value);
  };
  return (
    <div className="admin:flex admin:flex-wrap admin:items-center admin:gap-2">
      <span className={MONO} data-bound={row.bound ?? ""}>
        {row.bound ?? <span className="admin:text-text-muted">none</span>}
      </span>
      <select className={SELECT} aria-label={`Provider for ${row.key}`} value={row.choice} disabled={off} onChange={onChange}>
        {row.choices?.map((option) => (
          <OptionItem key={option.value} option={option} />
        ))}
      </select>
    </div>
  );
}

function Seats({ row, shared, off }: { readonly row: ConnectionRow; readonly shared: SharedWiring; readonly off: boolean }): ReactElement {
  const { store } = shared;
  const seats = row.seats ?? [];
  const bench = row.bench ?? [];
  if (seats.length === 0 && bench.length === 0) return <span className="admin:text-xs admin:text-text-muted">empty</span>;
  return (
    <ol className="admin:m-0 admin:flex admin:list-none admin:flex-col admin:gap-1 admin:p-0" aria-label={`Seats of ${row.key}`}>
      {seats.map((peer, i) => (
        <li key={peer.wire} className="admin:flex admin:flex-wrap admin:items-center admin:gap-1.5" data-peer={peer.port}>
          <span className="wiring-no">{peer.seat ?? i + 1}</span>
          <span className={MONO}>{peer.port}</span>
          {peer.byShape && <Pill tone="fit">by shape</Pill>}
          <span className="admin:ml-auto admin:flex admin:gap-1">
            <button type="button" className={SM} aria-label={`Move ${peer.port} up in ${row.key}`} disabled={off || i === 0} onClick={() => store.moveSeat(row.key, peer.port, -1)}>
              ↑
            </button>
            <button
              type="button"
              className={SM}
              aria-label={`Move ${peer.port} down in ${row.key}`}
              disabled={off || i === seats.length - 1}
              onClick={() => store.moveSeat(row.key, peer.port, 1)}
            >
              ↓
            </button>
            <CutButton peer={peer} shared={shared} off={off} />
          </span>
        </li>
      ))}
      {bench.map((peer) => (
        <li key={peer.wire} className="admin:flex admin:flex-wrap admin:items-center admin:gap-1.5 admin:opacity-60" data-peer={peer.port}>
          <span className="wiring-no">–</span>
          <span className={MONO}>{peer.port}</span>
          <Pill tone="warn">bench</Pill>
          {peer.byShape && <Pill tone="fit">by shape</Pill>}
          <span className="admin:ml-auto admin:flex admin:gap-1">
            <button type="button" className={SM} aria-label={`Seat ${peer.port} in ${row.key}`} disabled={off} onClick={() => shared.connect(peer.port, row.key)}>
              Seat
            </button>
            <CutButton peer={peer} shared={shared} off={off} />
          </span>
        </li>
      ))}
    </ol>
  );
}

function Peers({ row, peers, shared, off }: { readonly row: ConnectionRow; readonly peers: readonly Peer[]; readonly shared: SharedWiring; readonly off: boolean }): ReactElement {
  if (peers.length === 0) return <span className="admin:text-xs admin:text-text-muted">nobody</span>;
  return (
    <ul className="admin:m-0 admin:flex admin:list-none admin:flex-col admin:gap-1 admin:p-0" aria-label={`Wired to ${row.key}`}>
      {peers.map((peer) => (
        <li key={peer.wire} className={`admin:flex admin:flex-wrap admin:items-center admin:gap-1.5${peer.bench ? " admin:opacity-60" : ""}`} data-peer={peer.port}>
          <span className={MONO}>{peer.port}</span>
          {row.kind === "slot" && <Pill tone="muted">seat {peer.bench ? "–" : peer.seat}</Pill>}
          {peer.byShape && <Pill tone="fit">by shape</Pill>}
          <span className="admin:ml-auto">
            <CutButton peer={peer} shared={shared} off={off} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function CutButton({ peer, shared, off }: { readonly peer: Peer; readonly shared: SharedWiring; readonly off: boolean }): ReactElement {
  return (
    <button type="button" className={`${SM} ${DANGER}`} aria-label={`Cut ${peer.wire}`} disabled={off} onClick={() => shared.store.cutWire(peer.wire)}>
      Cut
    </button>
  );
}

function AddSelect({ row, options, shared, off }: { readonly row: ConnectionRow; readonly options: readonly Option[]; readonly shared: SharedWiring; readonly off: boolean }): ReactElement | null {
  if (options.length === 0) return null;
  const onChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const value = event.target.value;
    event.target.value = "";
    if (!value) return;
    // Consumed: the option provides into this port. Provided: this port feeds the option.
    if (row.dir === "in") shared.connect(value, row.key);
    else shared.connect(row.key, value);
  };
  return (
    <select className={SELECT} aria-label={`Add to ${row.key}`} value="" disabled={off} onChange={onChange}>
      <option value="">Add…</option>
      {options.map((option) => (
        <OptionItem key={option.value} option={option} />
      ))}
    </select>
  );
}

function OptionItem({ option }: { readonly option: Option }): ReactElement {
  return (
    <option value={option.value} disabled={option.disabled} title={option.title}>
      {option.label}
      {option.disabled && option.title ? ` · ${option.title}` : ""}
    </option>
  );
}

/**
 * The Plugins tab's draft bar: the same draft the graph's bar shows, with its count, the
 * plan in one line, Discard, Apply and the way to the graph.
 */
export function PluginsDraftBar({ shared, onOpen }: { readonly shared: SharedWiring; readonly onOpen: () => void }): ReactElement | null {
  const state = useEditor(shared.store);
  const notice = state.notice;
  if (!state.dirty && !notice) return null;
  const summary = state.summary;
  const plan = state.plan;
  const changes = summary?.rows.length ?? 0;
  const count = (tone: string, word: string, list: readonly string[] | undefined): ReactElement | null =>
    list && list.length > 0 ? (
      <Pill tone={tone} title={list.join(", ")}>
        {word} {list.length}
      </Pill>
    ) : null;
  return (
    <div
      className="wiring-connections admin:sticky admin:bottom-0 admin:z-[1] admin:flex admin:flex-col admin:gap-1 admin:rounded admin:border admin:border-border admin:bg-bg-raised admin:px-2 admin:py-1 admin:shadow-md"
      role="region"
      aria-label="Wiring draft"
    >
      {state.dirty && (
        <div className="admin:flex admin:flex-wrap admin:items-center admin:gap-2">
          <Pill tone="draft">draft</Pill>
          <Pill tone="warn">
            {changes} change{changes === 1 ? "" : "s"}
          </Pill>
          <Pill tone="muted">on v{state.live.version}</Pill>
          {state.draftAction === "rollback" && <Pill tone="fit">rollback v{state.draftFrom}</Pill>}
          {count("err", "stops", plan?.stop)}
          {count("warn", "restarts", plan?.restart)}
          {count("ok", "starts", plan?.start)}
          {summary && summary.addedErrors > 0 && (
            <Pill tone="err">
              +{summary.addedErrors} error{summary.addedErrors === 1 ? "" : "s"}
            </Pill>
          )}
          {summary?.stopsEditor && <Pill tone="err">stops editor</Pill>}
          {summary && summary.cold.length > 0 && (
            <Pill tone="warn" title={summary.cold.join(", ")}>
              reload · {summary.cold.length}
            </Pill>
          )}
          <ReadOnlyPill state={state} />
          <span className="admin:ml-auto admin:inline-flex admin:flex-wrap admin:gap-2">
            <button type="button" className={BTN} onClick={onOpen}>
              Wiring
            </button>
            <button type="button" className={BTN} disabled={state.busy} onClick={() => shared.store.discard()}>
              Discard
            </button>
            <button type="button" className={`${BTN} ${PRIMARY}`} disabled={state.busy || !!state.readOnly} onClick={() => shared.apply()}>
              Apply
            </button>
          </span>
        </div>
      )}
      {notice && (
        <span role="status" aria-live="polite" className={`${MONO} ${notice.bad ? "admin:text-danger" : "admin:text-text-muted"}`}>
          {notice.text}
        </span>
      )}
    </div>
  );
}
