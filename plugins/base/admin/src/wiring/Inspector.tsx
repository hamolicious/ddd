/**
 * The inspector: what is selected (a plugin, a port, a wire), the draft's changes and
 * apply plan, diagnostics, history and the `wiring.json` view. In the altbar on a wide
 * screen, in a bottom sheet on a phone (§7). Labels, counts, pills and tooltips; no prose.
 *
 * Every edit a touch user needs is a button here: Connect from the candidate list, Cut,
 * seat up/down, plug/unplug, load a version.
 */

import { useState } from "react";
import type { ReactElement, ReactNode } from "react";

import type { ShapeJson } from "@kernel";

import { formatWhen } from "./api.js";
import { badgeText, portTitle } from "./Graph.js";
import { useEditor } from "./hooks.js";
import { seatedWires, shapeFields, shortProtocol, type Port, type Wire } from "./model.js";
import type { EditorStore, Selection } from "./store.js";

export interface InspectorProps {
  readonly store: EditorStore;
  readonly onSelect: (selection: Selection) => void;
  readonly onConnect: (from: string, to: string) => void;
  readonly onApply: () => void;
  /** In a sheet: nothing the main view already shows (the draft bar). */
  readonly compact?: boolean;
}

const BTN = "admin:tap-h admin:inline-flex admin:cursor-pointer admin:items-center admin:justify-center admin:gap-1 admin:rounded admin:border admin:border-border admin:bg-bg-raised admin:px-2 admin:py-0.5 admin:text-xs admin:text-text admin:hover:border-border-strong admin:disabled:cursor-default admin:disabled:opacity-50";
const SM = `${BTN} admin:min-h-0 admin:px-1.5 admin:py-0 admin:text-[0.7rem] admin:touch:min-h-[var(--lm-tap-target)]`;
const DANGER = "admin:border-danger admin:text-danger";
const PRIMARY = "admin:border-accent admin:bg-accent admin:text-accent-text";
const LINK = "admin:cursor-pointer admin:border-0 admin:bg-transparent admin:p-0 admin:text-left admin:font-mono admin:text-[0.72rem] admin:text-link admin:underline-offset-2 admin:hover:underline";
const CAP = "admin:mb-0.5 admin:text-[0.62rem] admin:font-semibold admin:uppercase admin:tracking-wide admin:text-text-muted";
const MONO = "admin:font-mono admin:text-[0.7rem] admin:text-text-muted";

export function Pill({ tone, children, title }: { readonly tone: string; readonly children: ReactNode; readonly title?: string }): ReactElement {
  return (
    <span className={`wiring-pill ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Inspector({ store, onSelect, onConnect, onApply, compact }: InspectorProps): ReactElement {
  const state = useEditor(store);
  const { selection } = state;
  return (
    <div className="wiring-inspector admin:flex admin:flex-col admin:gap-3 admin:font-sans admin:text-sm admin:text-text">
      {selection?.kind === "wire" && <WireCard store={store} wireKey={selection.key} onSelect={onSelect} />}
      {selection?.kind === "port" && <PortCard store={store} portKey={selection.key} onSelect={onSelect} onConnect={onConnect} />}
      {selection?.kind === "node" && <NodeCard store={store} id={selection.id} onSelect={onSelect} />}
      {state.liveMoved && <LiveMovedCard store={store} />}
      {state.dirty && <ChangesCard store={store} onSelect={onSelect} onApply={onApply} compact={compact} />}
      <Section title="Diagnostics" count={state.resolution.diagnostics.length} tone={diagTone(state.resolution.diagnostics)} open={false}>
        <DiagnosticsList store={store} onSelect={onSelect} />
      </Section>
      <Section title="History" count={state.history.length} open={false}>
        <HistoryList store={store} />
      </Section>
      <Section title="wiring.json" count={state.dirty ? `draft · v${state.live.version + 1}` : `live · v${state.live.version}`} open={false}>
        <pre className="admin:m-0 admin:max-h-64 admin:overflow-auto admin:rounded admin:bg-bg-subtle admin:p-2 admin:font-mono admin:text-[0.68rem] admin:leading-snug">{store.wiringJson()}</pre>
      </Section>
      <Section title="Activation" count={state.resolution.order.length} open={false}>
        <ol className="admin:m-0 admin:flex admin:flex-wrap admin:gap-1 admin:p-0">
          {state.resolution.order.map((id, i) => (
            <li key={id} className="admin:list-none">
              <button type="button" className={LINK} onClick={() => onSelect({ kind: "node", id })}>
                <b className="admin:mr-0.5 admin:text-text-muted">{i + 1}</b>
                {id}
              </button>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

function diagTone(diagnostics: readonly { readonly severity: string }[]): string {
  if (diagnostics.some((d) => d.severity === "error")) return "err";
  return diagnostics.length ? "warn" : "ok";
}

export function Section({
  title,
  count,
  tone = "muted",
  open: initially = true,
  children,
}: {
  readonly title: string;
  readonly count?: number | string;
  readonly tone?: string;
  readonly open?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(initially);
  return (
    <section className="admin:border-t admin:border-border admin:pt-2">
      <h4 className="admin:m-0 admin:flex admin:items-center admin:gap-2 admin:text-sm admin:font-semibold">
        <button type="button" className={`${LINK} admin:font-sans admin:text-sm admin:text-text admin:no-underline`} aria-expanded={open} onClick={() => setOpen(!open)}>
          <span aria-hidden="true" className="admin:mr-1 admin:inline-block admin:w-3 admin:text-text-muted">
            {open ? "▾" : "▸"}
          </span>
          {title}
        </button>
        {count !== undefined && <Pill tone={tone}>{count}</Pill>}
      </h4>
      {open && <div className="admin:mt-1.5 admin:flex admin:flex-col admin:gap-1.5">{children}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function NodeLink({ id, onSelect }: { readonly id: string; readonly onSelect: (s: Selection) => void }): ReactElement {
  return (
    <button type="button" className={LINK} onClick={() => onSelect({ kind: "node", id })}>
      {id}
    </button>
  );
}

function PortLink({ port, label, onSelect }: { readonly port: string; readonly label?: string; readonly onSelect: (s: Selection) => void }): ReactElement {
  return (
    <button type="button" className={LINK} onClick={() => onSelect({ kind: "port", key: port })}>
      {label ?? port}
    </button>
  );
}

function NodeCard({ store, id, onSelect }: { readonly store: EditorStore; readonly id: string; readonly onSelect: (s: Selection) => void }): ReactElement | null {
  const state = useEditor(store);
  const node = state.graph.byId.get(id);
  if (!node) return null;
  const nodeState = store.nodeState(id);
  const tone = nodeState === "active" ? "ok" : "err";
  const skipped = state.resolution.skipped.find((entry) => entry.plugin === id);
  const also = state.plan ? (nodeState === "unplugged" ? state.plan.alsoStarts : state.plan.alsoStops).filter((x) => x !== id) : [];
  const ins = node.ports.filter((port) => port.dir === "in");
  const outs = node.ports.filter((port) => port.dir === "out");
  return (
    <section>
      <h4 className="admin:m-0 admin:flex admin:flex-wrap admin:items-center admin:gap-2 admin:text-sm admin:font-semibold">
        <span className="admin:font-mono">{id}</span>
        <Pill tone={tone} title={skipped ? `${skipped.reason}: ${skipped.detail}` : undefined}>
          {nodeState === "active" ? "activates" : nodeState}
        </Pill>
        <Pill tone="muted">v{node.version}</Pill>
        {!node.hot && <Pill tone="warn" title="not hot-pluggable: applying reloads clients">cold</Pill>}
      </h4>
      <div className="admin:mt-1.5 admin:flex admin:flex-wrap admin:items-center admin:gap-2">
        <button
          type="button"
          className={`${BTN} ${nodeState === "unplugged" ? "" : DANGER}`}
          disabled={!!state.readOnly}
          onClick={() => store.togglePlug(id)}
          aria-label={`${nodeState === "unplugged" ? "Plug in" : "Unplug"} ${id}`}
        >
          {nodeState === "unplugged" ? "Plug in" : "Unplug"}
        </button>
        {also.length > 0 && (
          <Pill tone={nodeState === "unplugged" ? "ok" : "err"} title={also.join(", ")}>
            {nodeState === "unplugged" ? "also starts" : "also stops"} {also.length}
          </Pill>
        )}
      </div>
      {also.length > 0 && (
        <div className="admin:mt-1 admin:flex admin:flex-wrap admin:gap-1">
          {also.map((other) => (
            <NodeLink key={other} id={other} onSelect={onSelect} />
          ))}
        </div>
      )}
      {ins.length > 0 && (
        <table className="wiring-table">
          <thead>
            <tr>
              <th>consumes</th>
              <th>from</th>
            </tr>
          </thead>
          <tbody>
            {ins.map((port) => {
              const wires = seatedWires(state.graph, port.key);
              return (
                <tr key={port.key}>
                  <td>
                    <PortLink port={port.key} label={port.name} onSelect={onSelect} />
                    <br />
                    <span className={MONO}>{shortProtocol(port.protocol)}</span>
                  </td>
                  <td>
                    {wires.length
                      ? wires.map((wire) => (
                          <span key={wire.key} className="admin:block">
                            {wire.kind === "slot" && <span className={`${MONO} admin:mr-1`}>{wire.bench ? "–" : wire.seat}</span>}
                            <NodeLink id={wire.fromNode} onSelect={onSelect} />
                          </span>
                        ))
                      : <span className="admin:text-text-muted">{port.optional ? "none · optional" : "none"}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {outs.length > 0 && (
        <table className="wiring-table">
          <thead>
            <tr>
              <th>provides</th>
              <th>to</th>
            </tr>
          </thead>
          <tbody>
            {outs.map((port) => {
              const wires = state.graph.wires.filter((wire) => wire.from === port.key);
              return (
                <tr key={port.key}>
                  <td>
                    <PortLink port={port.key} label={port.name} onSelect={onSelect} />
                    <br />
                    <span className={MONO}>{shortProtocol(port.protocol)}</span>
                  </td>
                  <td>
                    {wires.length
                      ? wires.map((wire) => (
                          <span key={wire.key} className="admin:block">
                            <NodeLink id={wire.toNode} onSelect={onSelect} />
                          </span>
                        ))
                      : <span className="admin:text-text-muted">nobody</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function TypeTable({ store, offer, need }: { readonly store: EditorStore; readonly offer: ShapeJson | undefined; readonly need: ShapeJson | undefined }): ReactElement | null {
  const needs = shapeFields(need);
  if (needs.length === 0 || !offer) return null;
  const offers = new Map(shapeFields(offer).map((field) => [field.key, field]));
  const needObject = need && typeof need === "object" && "object" in need ? need.object : {};
  return (
    <table className="wiring-table wiring-tc">
      <thead>
        <tr>
          <th>key</th>
          <th>needs</th>
          <th>offers</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {needs.map((field) => {
          const one: ShapeJson = { object: { [field.key]: needObject[field.key] as ShapeJson } };
          const problems = store.shapeFits(offer, one);
          const has = offers.get(field.key);
          return (
            <tr key={field.key}>
              <td className="admin:font-mono">{field.key}</td>
              <td className="admin:font-mono">
                {field.type}
                {field.optional ? "?" : ""}
              </td>
              <td className="admin:font-mono">{has ? `${has.type}${has.optional ? "?" : ""}` : "—"}</td>
              <td className={problems.length ? "admin:text-danger" : "admin:text-success"} title={problems.join("; ")}>
                {problems.length ? "✗" : "✓"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function WireCard({ store, wireKey, onSelect }: { readonly store: EditorStore; readonly wireKey: string; readonly onSelect: (s: Selection) => void }): ReactElement | null {
  const state = useEditor(store);
  const wire = store.wire(wireKey);
  if (!wire) return null;
  const from = store.port(wire.from);
  const to = store.port(wire.to);
  return (
    <section>
      <h4 className="admin:m-0 admin:flex admin:flex-wrap admin:items-center admin:gap-2 admin:text-sm admin:font-semibold">
        Wire
        <Pill tone={wire.kind}>{wire.kind}</Pill>
        {wire.byShape && <Pill tone="fit" title="wired by shape: the two ports do not share a protocol">by shape</Pill>}
        {wire.bench && <Pill tone="warn">bench</Pill>}
        {wire.kind === "slot" && !wire.bench && <Pill tone="muted">seat {wire.seat} / {state.graph.seatCount[wire.to] ?? 0}</Pill>}
      </h4>
      <div className="admin:mt-1 admin:flex admin:flex-wrap admin:items-center admin:gap-1">
        <PortLink port={wire.from} onSelect={onSelect} /> → <PortLink port={wire.to} onSelect={onSelect} />
      </div>
      <div className={`${MONO} admin:mt-0.5`}>
        {wire.offerProtocol}
        {from?.version ? `@${from.version}` : ""} → {wire.protocol}
        {to?.version ? `@${to.version}` : ""}
      </div>
      {from && to && <TypeTable store={store} offer={state.protocols.offerShape(from)} need={state.protocols.needShape(to)} />}
      <div className="admin:mt-1.5">
        <button type="button" className={`${BTN} ${DANGER}`} disabled={!!state.readOnly} onClick={() => store.cutWire(wire.key)}>
          Cut wire
        </button>
      </div>
    </section>
  );
}

function CandidateList({
  store,
  port,
  onSelect,
  onConnect,
}: {
  readonly store: EditorStore;
  readonly port: Port;
  readonly onSelect: (s: Selection) => void;
  readonly onConnect: (from: string, to: string) => void;
}): ReactElement {
  const state = useEditor(store);
  const items = store
    .candidates(port.key, port.dir)
    .map((candidate) => ({
      candidate,
      wired: state.graph.wires.some((wire) => (port.dir === "in" ? wire.from === candidate.port && wire.to === port.key : wire.from === port.key && wire.to === candidate.port)),
      weight: candidate.auto ? 0 : candidate.ok ? 1 : 2,
    }))
    .sort((a, b) => a.weight - b.weight || a.candidate.port.localeCompare(b.candidate.port));
  if (items.length === 0) return <span className="admin:text-xs admin:text-text-muted">{state.core ? "none" : "no core"}</span>;
  return (
    <ul className="admin:m-0 admin:flex admin:list-none admin:flex-col admin:gap-1 admin:p-0">
      {items.slice(0, 14).map(({ candidate, wired }) => {
        const other = store.port(candidate.port);
        const reason = !candidate.ok
          ? candidate.reasons.slice(0, 2).join("; ") || "out of range"
          : !candidate.auto
            ? candidate.same
              ? "version outside range; fits by shape"
              : `${other?.protocol ?? "?"}; fits by shape`
            : "";
        return (
          <li key={candidate.port} className="admin:flex admin:flex-wrap admin:items-center admin:gap-1.5">
            <span className={`wiring-mark ${candidate.auto ? "ok" : candidate.ok ? "fit" : "bad"}`} title={candidate.auto ? "same protocol, fits" : candidate.ok ? "fits by shape" : "does not fit"}>
              {candidate.auto ? "✓" : candidate.ok ? "◇" : "✗"}
            </span>
            <PortLink port={candidate.port} onSelect={onSelect} />
            {wired ? (
              <Pill tone="muted">wired</Pill>
            ) : candidate.ok ? (
              <button
                type="button"
                className={SM}
                disabled={!!state.readOnly}
                aria-label={`Connect ${port.dir === "in" ? candidate.port : port.key} to ${port.dir === "in" ? port.key : candidate.port}`}
                onClick={() => (port.dir === "in" ? onConnect(candidate.port, port.key) : onConnect(port.key, candidate.port))}
              >
                Connect
              </button>
            ) : null}
            {reason && (
              <span className={`${MONO} admin:basis-full`} title={candidate.reasons.join("; ")}>
                {reason}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function PortCard({
  store,
  portKey,
  onSelect,
  onConnect,
}: {
  readonly store: EditorStore;
  readonly portKey: string;
  readonly onSelect: (s: Selection) => void;
  readonly onConnect: (from: string, to: string) => void;
}): ReactElement | null {
  const state = useEditor(store);
  const port = store.port(portKey);
  if (!port) return null;
  const status = state.resolution.status[port.key];
  const fields = shapeFields(port.dir === "in" ? state.protocols.needShape(port) : state.protocols.offerShape(port));
  const wires: readonly Wire[] = port.dir === "in" ? seatedWires(state.graph, port.key) : state.graph.wires.filter((wire) => wire.from === port.key);
  const seats = wires.filter((wire) => !wire.bench);
  const edited = port.dir === "in" && port.kind === "slot" && state.draft.order[port.key] !== undefined;
  return (
    <section>
      <h4 className="admin:m-0 admin:flex admin:flex-wrap admin:items-center admin:gap-2 admin:text-sm admin:font-semibold">
        <span className="admin:font-mono">
          {port.plugin} · {port.name}
        </span>
        <Pill tone={port.kind}>{port.kind === "slot" && port.dir === "in" ? (port.seats === 1 ? "1 seat" : "multi-seat") : port.kind}</Pill>
        {status && (
          <Pill tone={`badge-${status.code}`} title={status.code}>
            {badgeText(status)}
          </Pill>
        )}
      </h4>
      <div className={`${MONO} admin:mt-0.5`} title={portTitle(port)}>
        {port.dir === "in" ? "consumes" : "provides"} {port.protocol}
        {port.version ? `@${port.version}` : ""}
        {port.optional ? " · optional" : ""}
      </div>
      <div className="admin:mt-1.5">
        <div className={CAP}>{port.dir === "out" ? "wired to" : port.kind === "slot" ? "seats" : port.kind === "service" ? "bound to" : "listening to"}</div>
        {wires.length === 0 ? (
          <span className="admin:text-xs admin:text-text-muted">{port.dir === "in" && port.kind === "service" && !port.optional ? "nothing · will not activate" : "nothing"}</span>
        ) : port.dir === "in" && port.kind === "slot" ? (
          <ol className="admin:m-0 admin:flex admin:list-none admin:flex-col admin:gap-1 admin:p-0">
            {wires.map((wire, i) => (
              <li key={wire.key} className={`admin:flex admin:flex-wrap admin:items-center admin:gap-1.5${wire.bench ? " admin:opacity-60" : ""}`}>
                <span className="wiring-no">{wire.bench ? "–" : wire.seat}</span>
                <NodeLink id={wire.fromNode} onSelect={onSelect} />
                {wire.byShape && <Pill tone="fit">by shape</Pill>}
                <span className="admin:ml-auto admin:flex admin:gap-1">
                  {!wire.bench && (
                    <>
                      <button type="button" className={SM} aria-label={`Move ${wire.fromNode} up`} disabled={!!state.readOnly || i === 0} onClick={() => store.moveSeat(port.key, wire.from, -1)}>
                        ↑
                      </button>
                      <button
                        type="button"
                        className={SM}
                        aria-label={`Move ${wire.fromNode} down`}
                        disabled={!!state.readOnly || i === seats.length - 1}
                        onClick={() => store.moveSeat(port.key, wire.from, 1)}
                      >
                        ↓
                      </button>
                    </>
                  )}
                  <button type="button" className={`${SM} ${DANGER}`} aria-label={`Cut ${wire.from}`} disabled={!!state.readOnly} onClick={() => store.cutWire(wire.key)}>
                    Cut
                  </button>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <ul className="admin:m-0 admin:flex admin:list-none admin:flex-col admin:gap-1 admin:p-0">
            {wires.map((wire) => (
              <li key={wire.key} className="admin:flex admin:flex-wrap admin:items-center admin:gap-1.5">
                <span className="wiring-mark ok">●</span>
                {port.dir === "in" ? <NodeLink id={wire.fromNode} onSelect={onSelect} /> : <PortLink port={wire.to} onSelect={onSelect} />}
                {wire.kind === "slot" && port.dir === "out" && <Pill tone="muted">seat {wire.bench ? "–" : wire.seat}</Pill>}
                <button type="button" className={`${SM} ${DANGER} admin:ml-auto`} aria-label={`Cut ${wire.key}`} disabled={!!state.readOnly} onClick={() => store.cutWire(wire.key)}>
                  Cut
                </button>
              </li>
            ))}
          </ul>
        )}
        {edited && (
          <div className="admin:mt-1 admin:flex admin:items-center admin:gap-2">
            <Pill tone="warn" title="seat order set by hand, stored in `order`">
              order
            </Pill>
            <button type="button" className={SM} disabled={!!state.readOnly} onClick={() => store.resetOrder(port.key)}>
              Default order
            </button>
          </div>
        )}
      </div>
      {fields.length > 0 && (
        <div className="admin:mt-1.5">
          <div className={CAP}>{port.dir === "in" ? `needs${port.needs ? " · slice" : ""}` : "offers"}</div>
          <div className="admin:flex admin:flex-wrap admin:gap-1">
            {fields.map((field) => (
              <code key={field.key} className="wiring-code">
                {field.key}
                {field.optional ? "?" : ""}: {field.type}
              </code>
            ))}
          </div>
        </div>
      )}
      <div className="admin:mt-1.5">
        <div className={CAP}>could connect</div>
        <CandidateList store={store} port={port} onSelect={onSelect} onConnect={onConnect} />
      </div>
    </section>
  );
}

function LiveMovedCard({ store }: { readonly store: EditorStore }): ReactElement | null {
  const state = useEditor(store);
  const moved = state.liveMoved;
  if (!moved) return null;
  return (
    <section className="admin:rounded admin:border admin:border-warning admin:p-2">
      <h4 className="admin:m-0 admin:flex admin:items-center admin:gap-2 admin:text-sm admin:font-semibold">
        Live moved
        <Pill tone="warn">
          v{moved.from} → v{moved.to}
        </Pill>
        {moved.overlapping.length > 0 && (
          <Pill tone="err" title={moved.overlapping.join("\n")}>
            {moved.overlapping.length} overlap
          </Pill>
        )}
      </h4>
      {moved.changed.length > 0 && (
        <ul className="admin:m-0 admin:mt-1 admin:flex admin:list-none admin:flex-col admin:gap-0.5 admin:p-0">
          {moved.changed.map((line) => (
            <li key={line} className={MONO}>
              {line}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ChangesCard({
  store,
  onSelect,
  onApply,
  compact,
}: {
  readonly store: EditorStore;
  readonly onSelect: (s: Selection) => void;
  readonly onApply: () => void;
  readonly compact?: boolean;
}): ReactElement | null {
  const state = useEditor(store);
  const summary = state.summary;
  return (
    <section className="wiring-changes admin:rounded admin:border admin:border-border admin:p-2">
      <h4 className="admin:m-0 admin:flex admin:flex-wrap admin:items-center admin:gap-2 admin:text-sm admin:font-semibold">
        Changes
        <Pill tone="warn">{summary?.rows.length ?? 0}</Pill>
        <Pill tone="muted" title="the live version this draft started from">
          on v{state.live.version}
        </Pill>
        {state.draftAction === "rollback" && <Pill tone="fit">rollback v{state.draftFrom}</Pill>}
        {summary && summary.addedErrors > 0 && (
          <Pill tone="err" title="the draft adds errors; Apply will ask">
            +{summary.addedErrors} error{summary.addedErrors === 1 ? "" : "s"}
          </Pill>
        )}
        {summary?.stopsEditor && (
          <Pill tone="err" title="this draft stops the wiring editor itself; Apply will ask">
            stops editor
          </Pill>
        )}
      </h4>
      {summary && (
        <>
          <ul className="admin:m-0 admin:mt-1 admin:flex admin:list-none admin:flex-col admin:gap-0.5 admin:p-0">
            {summary.rows.map((row, i) => (
              <li key={`${row.text}:${i}`} className="admin:flex admin:items-start admin:gap-1.5">
                <span className={`wiring-op ${row.op}`}>{row.op === "add" ? "+" : row.op === "del" ? "−" : "~"}</span>
                {row.node ? (
                  <NodeLink id={row.node} onSelect={onSelect} />
                ) : row.port ? (
                  <PortLink port={row.port} label={row.text} onSelect={onSelect} />
                ) : (
                  <span className={MONO}>{row.text}</span>
                )}
                {row.node && <span className={MONO}>{row.text.replace(row.node, "").trim()}</span>}
              </li>
            ))}
          </ul>
          {summary.alsoStops.length > 0 && (
            <div className="admin:mt-1 admin:flex admin:flex-wrap admin:items-center admin:gap-1">
              <Pill tone="err">also stops</Pill>
              {summary.alsoStops.map((id) => (
                <NodeLink key={id} id={id} onSelect={onSelect} />
              ))}
            </div>
          )}
          {summary.alsoStarts.length > 0 && (
            <div className="admin:mt-1 admin:flex admin:flex-wrap admin:items-center admin:gap-1">
              <Pill tone="ok">also starts</Pill>
              {summary.alsoStarts.map((id) => (
                <NodeLink key={id} id={id} onSelect={onSelect} />
              ))}
            </div>
          )}
          <div className={`${CAP} admin:mt-1.5`}>apply plan</div>
          <ol className="admin:m-0 admin:flex admin:flex-col admin:gap-0.5 admin:pl-4">
            <li className={MONO}>save v{state.live.version + 1} · wiring.applied</li>
            {summary.steps.map((step) => (
              <li key={step} className={MONO}>
                {step}
              </li>
            ))}
            <li className={MONO}>{summary.cold.length ? "reload banner" : "no reload"}</li>
          </ol>
        </>
      )}
      {!compact && (
        <div className="admin:mt-2 admin:flex admin:gap-2">
          <button type="button" className={BTN} disabled={state.busy} onClick={() => store.discard()}>
            Discard
          </button>
          <button type="button" className={`${BTN} ${PRIMARY}`} disabled={state.busy || !!state.readOnly} onClick={onApply}>
            Apply
          </button>
        </div>
      )}
    </section>
  );
}

function DiagnosticsList({ store, onSelect }: { readonly store: EditorStore; readonly onSelect: (s: Selection) => void }): ReactElement {
  const state = useEditor(store);
  const diagnostics = state.resolution.diagnostics;
  if (diagnostics.length === 0) return <Pill tone="ok">ok</Pill>;
  return (
    <ul className="admin:m-0 admin:flex admin:list-none admin:flex-col admin:gap-1 admin:p-0">
      {diagnostics.map((d, i) => (
        <li key={`${d.plugin}:${d.code}:${i}`} className="admin:flex admin:items-start admin:gap-1.5">
          <Pill tone={d.severity === "error" ? "err" : "warn"}>{d.severity === "error" ? "error" : "warn"}</Pill>
          <button type="button" className={`${LINK} admin:font-sans admin:text-xs admin:text-text`} title={d.code} onClick={() => onSelect(d.port ? { kind: "port", key: d.port } : { kind: "node", id: d.plugin })}>
            {d.message}
          </button>
        </li>
      ))}
    </ul>
  );
}

function HistoryList({ store }: { readonly store: EditorStore }): ReactElement {
  const state = useEditor(store);
  if (state.history.length === 0) return <span className="admin:text-xs admin:text-text-muted">{state.routes ? "none" : "no wiring routes"}</span>;
  return (
    <ol className="wiring-history admin:m-0 admin:flex admin:list-none admin:flex-col admin:gap-1 admin:p-0">
      {state.history.map((entry) => (
        <li key={entry.version} className="admin:flex admin:flex-wrap admin:items-center admin:gap-1.5">
          <Pill tone={entry.version === state.live.version ? "ok" : "muted"}>v{entry.version}</Pill>
          <span className="admin:text-xs">{entry.action}</span>
          <span className={MONO} title={entry.subject ? `${entry.actor ?? ""} · ${entry.subject}` : (entry.actor ?? "")}>
            {entry.actor ?? "—"}
            {entry.subject ? ` · ${entry.subject}` : ""}
          </span>
          <span className={`${MONO} admin:ml-auto`}>{formatWhen(entry.at)}</span>
          {entry.version !== state.live.version && (
            <button type="button" className={SM} disabled={!!state.readOnly} aria-label={`Load v${entry.version} as a draft`} onClick={() => void store.loadVersion(entry.version)}>
              Load
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
