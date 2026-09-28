/**
 * The graph: boxes in columns, ports on their edges, wires between them, seats stacked
 * down a host's edge (PLUGIN-PROTOCOLS §7). Every coordinate comes from `layout.ts`, so
 * nothing here measures the DOM.
 *
 * Gestures: drag from a port dot to wire (compatible dots light up, the rest fade and say
 * why); click a wire to select it; the power button unplugs; drag a title to move a box;
 * drag the background to pan; wheel to zoom. The draft is drawn over the live wiring: new
 * wires bold, removed ones as red ghosts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";

import { useEditor } from "./hooks.js";
import { NODE_W, SEAT_R, along, curve, outward, portPoint, seatPoint, type NodeGeometry, type Point, type PortGeometry } from "./layout.js";
import { shortProtocol, type Port, type Wire } from "./model.js";
import type { EditorStore, Selection } from "./store.js";

interface GraphProps {
  readonly store: EditorStore;
  /** A selection was made by pointer: the view decides where the inspector goes. */
  readonly onSelect: (selection: Selection) => void;
  readonly onConnect: (from: string, to: string) => void;
}

type Drag =
  | { readonly type: "wire"; readonly dir: "in" | "out"; readonly key: string; cur: Point; bad: boolean }
  | { readonly type: "node"; readonly id: string; readonly dx: number; readonly dy: number; moved: boolean }
  | { readonly type: "pan"; readonly sx: number; readonly sy: number; readonly vx: number; readonly vy: number; moved: boolean };

interface Compat {
  readonly dir: "in" | "out";
  readonly key: string;
  /** Port key → its mark; a port on the other side that is absent does not fit. */
  readonly marks: ReadonlyMap<string, { readonly mark: "auto" | "fits" | "no"; readonly why: string }>;
}

const POWER = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M8 1.5v6" />
    <path d="M4.2 4a5.5 5.5 0 1 0 7.6 0" />
  </svg>
);

export function Graph({ store, onSelect, onConnect }: GraphProps): ReactElement {
  const state = useEditor(store);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | undefined>(undefined);
  const [temp, setTemp] = useState<{ readonly dir: "in" | "out"; readonly key: string; readonly cur: Point; readonly bad: boolean } | undefined>();
  const [hoverNode, setHoverNode] = useState<string | undefined>();
  const [compat, setCompat] = useState<Compat | undefined>();
  const { graph, liveGraph, geometry, positions, view, selection, kinds, protocolFilter, dirty, readOnly } = state;
  const counts = useMemo(() => store.counts(), [store, graph]);

  const toWorld = useCallback(
    (cx: number, cy: number): Point => {
      const r = canvas.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const v = store.state.view;
      return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k };
    },
    [store],
  );

  // Wheel zoom needs `preventDefault`, which React's passive wheel listener cannot do.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const r = element.getBoundingClientRect();
      store.zoom(Math.exp(-event.deltaY * 0.0015), event.clientX - r.left, event.clientY - r.top);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [store]);

  // Fit once the boxes exist and the canvas has a size.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || Object.keys(positions).length === 0) return;
    const element = canvas.current;
    if (!element || element.clientWidth === 0) return;
    fitted.current = true;
    store.fit(element.clientWidth, element.clientHeight);
  }, [store, positions]);

  const markCompat = useCallback(
    (dir: "in" | "out", key: string): void => {
      const me = store.port(key);
      if (!me) return;
      const marks = new Map<string, { mark: "auto" | "fits" | "no"; why: string }>();
      for (const candidate of store.candidates(key, dir)) {
        marks.set(candidate.port, {
          mark: candidate.auto ? "auto" : candidate.ok ? "fits" : "no",
          why: candidate.ok ? (candidate.auto ? "same protocol" : "fits by shape") : candidate.reasons.slice(0, 3).join("; ") || "does not fit",
        });
      }
      setCompat({ dir, key, marks });
    },
    [store],
  );

  const portAt = (target: EventTarget | null): { readonly key: string; readonly dir: "in" | "out"; readonly element: HTMLElement } | undefined => {
    const element = (target as HTMLElement | null)?.closest?.("[data-port]") as HTMLElement | null;
    if (!element) return undefined;
    return { key: element.dataset["port"] ?? "", dir: element.dataset["dir"] === "in" ? "in" : "out", element };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const plug = target.closest("[data-plug]") as HTMLElement | null;
    if (plug) {
      event.preventDefault();
      store.togglePlug(plug.dataset["plug"] ?? "");
      onSelect({ kind: "node", id: plug.dataset["plug"] ?? "" });
      return;
    }
    const dot = readOnly ? null : target.closest("[data-dot]");
    const head = target.closest("[data-head]");
    const path = target.closest("[data-wire]") as SVGElement | null;
    const port = portAt(target);
    const node = target.closest("[data-node]") as HTMLElement | null;
    if (dot && port) {
      const cur = toWorld(event.clientX, event.clientY);
      drag.current = { type: "wire", dir: port.dir, key: port.key, cur, bad: false };
      setTemp({ dir: port.dir, key: port.key, cur, bad: false });
      markCompat(port.dir, port.key);
    } else if (head && node) {
      const id = node.dataset["node"] ?? "";
      const w = toWorld(event.clientX, event.clientY);
      const p = positions[id] ?? { x: 0, y: 0 };
      drag.current = { type: "node", id, dx: w.x - p.x, dy: w.y - p.y, moved: false };
    } else if (path) {
      onSelect({ kind: "wire", key: path.dataset["wire"] ?? "" });
      return;
    } else if (port) {
      onSelect({ kind: "port", key: port.key });
      return;
    } else if (node) {
      onSelect({ kind: "node", id: node.dataset["node"] ?? "" });
      return;
    } else {
      drag.current = { type: "pan", sx: event.clientX, sy: event.clientY, vx: view.x, vy: view.y, moved: false };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) {
      const target = event.target as HTMLElement;
      const dot = target.closest?.("[data-dot]");
      const port = dot ? portAt(target) : undefined;
      if (port && !readOnly) {
        if (!compat || compat.key !== port.key || compat.dir !== port.dir) markCompat(port.dir, port.key);
      } else if (compat) setCompat(undefined);
      const node = (target.closest?.("[data-node]") as HTMLElement | null)?.dataset["node"];
      if (node !== hoverNode) setHoverNode(node);
      return;
    }
    if (d.type === "pan") {
      d.moved = true;
      store.setView({ ...store.state.view, x: d.vx + event.clientX - d.sx, y: d.vy + event.clientY - d.sy });
    } else if (d.type === "node") {
      const w = toWorld(event.clientX, event.clientY);
      d.moved = true;
      store.moveNode(d.id, { x: w.x - d.dx, y: w.y - d.dy });
    } else {
      d.cur = toWorld(event.clientX, event.clientY);
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const port = portAt(under);
      d.bad = !!port && (port.dir === d.dir || compat?.marks.get(port.key)?.mark === "no" || !compat?.marks.has(port.key));
      setTemp({ dir: d.dir, key: d.key, cur: d.cur, bad: d.bad });
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = undefined;
    if (d.type === "wire") {
      setTemp(undefined);
      setCompat(undefined);
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const port = portAt(under);
      if (port && port.dir !== d.dir) {
        if (d.dir === "out") onConnect(d.key, port.key);
        else onConnect(port.key, d.key);
      } else if (port) store.notice("connect a provided port to a consumed port", true);
      return;
    }
    if (d.type === "node" && !d.moved) onSelect({ kind: "node", id: d.id });
    if (d.type === "pan" && !d.moved) onSelect(undefined);
  };

  const onPointerCancel = (): void => {
    drag.current = undefined;
    setTemp(undefined);
    setCompat(undefined);
  };

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  const focus = selection?.kind === "node" ? selection.id : !selection ? hoverNode : undefined;
  const selectedPort = selection?.kind === "port" ? store.port(selection.key) : undefined;
  const selectedWire = selection?.kind === "wire" ? selection.key : undefined;
  const visible = (wire: Wire): boolean =>
    kinds[wire.kind] && (!protocolFilter || wire.protocol === protocolFilter || wire.offerProtocol === protocolFilter);
  const throughPort = (wire: Wire): boolean =>
    !!selectedPort && (selectedPort.dir === "in" ? wire.to === selectedPort.key : wire.from === selectedPort.key);

  const geometryOf = (key: string): { readonly node: NodeGeometry; readonly at: Point; readonly port: PortGeometry } | undefined => {
    const id = key.slice(0, key.lastIndexOf(":"));
    const node = geometry[id];
    const at = positions[id];
    const port = node?.ports.get(key);
    return node && at && port ? { node, at, port } : undefined;
  };
  const endsOf = (wire: Wire): readonly [Point, Point, 1 | -1, 1 | -1] | undefined => {
    const from = geometryOf(wire.from);
    const to = geometryOf(wire.to);
    if (!from || !to) return undefined;
    const a = portPoint(from.node, from.at, from.port);
    const b = wire.kind === "slot" ? seatPoint(to.at, to.port, wire.bench ? 1 : (wire.seat ?? 1)) : portPoint(to.node, to.at, to.port);
    return [a, b, outward(from.port.port.side), outward(to.port.port.side)];
  };

  const liveKeys = useMemo(() => new Set(liveGraph.wires.map((wire) => wire.key)), [liveGraph]);
  const draftKeys = useMemo(() => new Set(graph.wires.map((wire) => wire.key)), [graph]);

  const ghosts = dirty
    ? liveGraph.wires
        .filter((wire) => visible(wire) && !draftKeys.has(wire.key))
        .map((wire) => {
          const ends = endsOf(wire);
          return ends ? <path key={`gone:${wire.key}`} className={`wiring-w ${wire.kind} gone`} d={curve(...ends)} /> : null;
        })
    : null;

  const wires: ReactElement[] = [];
  const labels: ReactElement[] = [];
  for (const wire of graph.wires) {
    if (!visible(wire)) continue;
    const ends = endsOf(wire);
    if (!ends) continue;
    const [a, b, sa, sb] = ends;
    const d = curve(a, b, sa, sb);
    let cls = `wiring-w ${wire.kind}${wire.byShape ? " byshape" : ""}${wire.bench ? " bench" : ""}${dirty && !liveKeys.has(wire.key) ? " new" : ""}`;
    if (selectedWire === wire.key) cls += " sel";
    else if (selectedPort) cls += throughPort(wire) ? " hot" : " dim";
    else if (focus) cls += wire.fromNode === focus || wire.toNode === focus ? " hot" : " dim";
    wires.push(<path key={`hit:${wire.key}`} className="wiring-hit" data-wire={wire.key} d={d} />);
    wires.push(<path key={wire.key} className={cls} data-wire={wire.key} d={d} />);
    const showNo =
      wire.kind === "slot" &&
      !wire.bench &&
      (graph.seatCount[wire.to] ?? 0) > 1 &&
      ((selectedPort && throughPort(wire)) || selectedWire === wire.key || (focus && wire.toNode === focus));
    if (showNo) {
      const q = along(a, b, sa, sb, 0.86);
      labels.push(
        <g key={`no:${wire.key}`} className="wiring-seatno">
          <circle cx={q.x} cy={q.y} r={8} />
          <text x={q.x} y={q.y}>
            {wire.seat}
          </text>
        </g>,
      );
    }
  }

  const seats: ReactElement[] = [];
  if (kinds.slot) {
    for (const node of graph.nodes) {
      const g = geometry[node.id];
      const at = positions[node.id];
      if (!g || !at) continue;
      for (const pg of g.left) {
        const port = pg.port;
        if (port.kind !== "slot" || port.dir !== "in" || (protocolFilter && port.protocol !== protocolFilter)) continue;
        const count = graph.seatCount[port.key] ?? 0;
        for (let i = pg.seatTotal; i >= 1; i -= 1) {
          const p = seatPoint(at, pg, i);
          seats.push(<circle key={`${port.key}:${i}`} className={`wiring-seat${i > count ? " open" : ""}`} cx={p.x} cy={p.y} r={SEAT_R} />);
        }
      }
    }
  }

  let tempPath: ReactElement | null = null;
  if (temp) {
    const g = geometryOf(temp.key);
    if (g) {
      const p = portPoint(g.node, g.at, g.port);
      const s = outward(g.port.port.side);
      tempPath = <path className={`wiring-temp${temp.bad ? " bad" : ""}`} d={temp.dir === "out" ? curve(p, temp.cur, s, -s) : curve(temp.cur, p, -s, s)} />;
    }
  }

  const involved = (id: string): boolean => {
    if (selectedPort) return id === selectedPort.plugin || graph.wires.some((wire) => throughPort(wire) && (wire.fromNode === id || wire.toNode === id));
    if (focus) return focus === id || graph.wires.some((wire) => visible(wire) && ((wire.fromNode === focus && wire.toNode === id) || (wire.toNode === focus && wire.fromNode === id)));
    return true;
  };

  return (
    <div
      ref={canvas}
      className={`wiring-canvas admin:relative admin:h-full admin:w-full admin:overflow-hidden admin:touch-none admin:select-none${drag.current?.type === "pan" ? " panning" : ""}`}
      role="application"
      aria-label="Wiring graph"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => hoverNode && setHoverNode(undefined)}
    >
      <div className="wiring-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="wiring-layer" width={1} height={1} aria-hidden="true">
          {ghosts}
          {wires}
        </svg>
        {!state.handPlaced &&
          state.columns.map((column, index) => {
            const x = positions[column.ids[0] ?? ""]?.x ?? 0;
            return (
              <div key={index} className="wiring-collabel" style={{ transform: `translate(${x}px, -30px)` }}>
                {column.lo === column.hi ? column.lo : `${column.lo}–${column.hi}`} dependant{column.hi === 1 ? "" : "s"}
              </div>
            );
          })}
        {graph.nodes.map((node) => {
          const g = geometry[node.id];
          const at = positions[node.id];
          if (!g || !at) return null;
          const nodeState = store.nodeState(node.id);
          const protoHit = !protocolFilter || node.ports.some((port) => port.protocol === protocolFilter);
          const cls = [
            "wiring-node",
            selection?.kind === "node" && selection.id === node.id ? "sel" : "",
            nodeState === "skipped" ? "off" : "",
            nodeState === "unplugged" ? "unplugged" : "",
            !involved(node.id) || !protoHit ? "dim" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div key={node.id} className={cls} data-node={node.id} style={{ transform: `translate(${at.x}px, ${at.y}px)`, width: NODE_W, height: g.height }}>
              <div className="wiring-node-h" data-head="">
                <span className="wiring-nm">{node.id}</span>
                <span className="wiring-dc" title="plugins that depend on this one">
                  {counts[node.id] ?? 0}
                </span>
                <span className={`wiring-org${node.base ? " base" : ""}`}>{node.base ? "base" : "3rd party"}</span>
                <button
                  type="button"
                  className="wiring-plug"
                  data-plug={node.id}
                  disabled={!!readOnly}
                  title={nodeState === "unplugged" ? "Plug in" : "Unplug"}
                  aria-label={`${nodeState === "unplugged" ? "Plug in" : "Unplug"} ${node.id}`}
                  aria-pressed={nodeState === "unplugged"}
                >
                  {POWER}
                </button>
              </div>
              {g.left.length > 0 && (
                <div className="wiring-ports L">
                  <div className="wiring-cap">← used by</div>
                  {g.left.map((pg) => (
                    <PortRow key={pg.port.key} geometry={pg} store={store} compat={compat} picked={selectedPort?.key === pg.port.key} />
                  ))}
                </div>
              )}
              {g.right.length > 0 && (
                <div className="wiring-ports R">
                  <div className="wiring-cap">uses →</div>
                  {g.right.map((pg) => (
                    <PortRow key={pg.port.key} geometry={pg} store={store} compat={compat} picked={selectedPort?.key === pg.port.key} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <svg className="wiring-layer wiring-top" width={1} height={1} aria-hidden="true">
          {seats}
          {labels}
          {tempPath}
        </svg>
      </div>
    </div>
  );
}

function PortRow({
  geometry,
  store,
  compat,
  picked,
}: {
  readonly geometry: PortGeometry;
  readonly store: EditorStore;
  readonly compat: Compat | undefined;
  readonly picked: boolean;
}): ReactElement {
  const port = geometry.port;
  const status = store.state.resolution.status[port.key];
  let mark = "";
  let title = portTitle(port);
  if (compat && !(compat.key === port.key && compat.dir === port.dir)) {
    if (compat.dir === port.dir) mark = "nocompat";
    else {
      const m = compat.marks.get(port.key);
      mark = m ? (m.mark === "auto" ? "compat" : m.mark === "fits" ? "fits" : "nocompat") : "nocompat";
      title = m ? m.why : "does not fit";
    }
  }
  const dot = <span className={`wiring-pd ${port.kind}`} data-dot="" />;
  const name = <span className="wiring-pn">{port.name}</span>;
  const proto = <span className="wiring-pp">{shortProtocol(port.protocol)}</span>;
  const badge = <span className="wiring-bslot">{status ? <span className={`wiring-badge ${status.code}`}>{badgeText(status)}</span> : null}</span>;
  return (
    <div
      className={`wiring-port ${port.dir} ${port.side}${geometry.seatTotal > 1 ? " multi" : ""}${picked ? " picked" : ""}${mark ? ` ${mark}` : ""}`}
      data-port={port.key}
      data-dir={port.dir}
      title={title}
      style={{ height: geometry.height }}
    >
      {port.side === "L" ? (
        <>
          {dot}
          {name}
          {proto}
          {badge}
        </>
      ) : (
        <>
          {badge}
          {proto}
          {name}
          {dot}
        </>
      )}
    </div>
  );
}

export function portTitle(port: Port): string {
  if (port.dir === "out") return `${port.protocol}@${port.version}`;
  return `${port.protocol}@${port.version}${port.needs ? ` · needs ${port.needs.join(", ")}` : ""}${port.optional ? " · optional" : ""}${port.seats === 1 ? " · 1 seat" : ""}`;
}

export function badgeText(status: { readonly code: string; readonly count?: number }): string {
  switch (status.code) {
    case "providers":
      return `${status.count ?? 2} providers`;
    case "pinned":
      return "pinned";
    case "pin-missing":
      return "pin missing";
    case "no-fit":
      return "no fit";
    default:
      return status.code;
  }
}
