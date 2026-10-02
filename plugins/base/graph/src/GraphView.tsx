import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";

import type { DocumentId } from "@kernel";

import type { WorkspaceIndex } from "plugin:indexer";

import { Controls, LocalControls } from "./Controls.js";
import { buildGraph, neighbourhood, shapeKey, type Graph } from "./model.js";
import { GraphCanvas } from "./renderer.js";
import { displayOf, filterOf, forcesOf, type SettingsStore } from "./settings.js";
import { Simulation, type SimNode } from "./simulation.js";

export interface GraphViewProps {
  readonly indexer: Pick<WorkspaceIndex, "ready" | "version" | "documents" | "connections" | "subscribe">;
  readonly store: SettingsStore;
  readonly open: (id: DocumentId, newTab: boolean) => void;
  readonly center?: DocumentId;
  readonly openGlobal?: () => void;
  readonly focus?: DocumentId;
}

const EMPTY: Graph = { nodes: [], links: [] };

export function GraphView({ indexer, store, open, center, openGlobal, focus }: GraphViewProps): ReactElement {
  const settings = useSyncExternalStore(store.subscribe, store.get);
  const version = useSyncExternalStore(indexer.subscribe, () => indexer.version);
  const [ready, setReady] = useState(false);
  const [search, setSearch] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engine = useRef<{ sim: Simulation; canvas: GraphCanvas; shape: string | undefined }>();
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    let live = true;
    indexer.ready.then(
      () => live && setReady(true),
      () => live && setReady(true),
    );
    return () => {
      live = false;
    };
  }, [indexer]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return undefined;
    const sim = new Simulation(forcesOf(store.get()));
    const canvas = new GraphCanvas(element, sim, { open: (id, newTab) => openRef.current(id, newTab) });
    engine.current = { sim, canvas, shape: undefined };
    return () => {
      canvas.destroy();
      engine.current = undefined;
    };
  }, [store]);

  const filter = useMemo(
    () => filterOf(settings, center ? "" : search),
    [center, search, settings.showOrphans, settings.showMissing, settings.showEmbeds, settings.showFrontmatter],
  );

  const graph = useMemo(() => {
    if (!ready) return EMPTY;
    const whole = buildGraph(indexer, center ? { ...filter, showOrphans: true } : filter);
    return center ? neighbourhood(whole, center, Math.max(1, Math.round(settings.localDepth)), indexer) : whole;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, indexer, version, filter, center, settings.localDepth]);

  useEffect(() => {
    const current = engine.current;
    if (!current) return;
    const shape = shapeKey(graph);
    let leaving: SimNode[] = [];
    if (shape !== current.shape) {
      const first = current.shape === undefined || current.sim.nodes.length === 0;
      const staying = new Set(graph.nodes.map((node) => node.id));
      leaving = current.sim.nodes.filter((node) => !staying.has(node.id));
      current.sim.setGraph(graph.nodes, graph.links);
      current.sim.reheat(first ? 1 : 0.3);
      current.shape = shape;
    }
    current.canvas.setGraph(graph, leaving);
  }, [graph]);

  useEffect(() => {
    engine.current?.canvas.setDisplay(displayOf(settings));
  }, [settings.arrows, settings.sizeByLinks, settings.textFade, settings.nodeSize, settings.linkThickness, settings.colorByFolder]);

  useEffect(() => {
    const current = engine.current;
    if (!current) return;
    current.sim.forces = forcesOf(settings);
    current.sim.reheat(0.3);
    current.canvas.wake();
  }, [settings.centerForce, settings.repelForce, settings.linkForce, settings.linkDistance]);

  useEffect(() => {
    engine.current?.canvas.setHighlight(center ?? focus);
    engine.current?.canvas.setAnchor(center);
  }, [center, focus]);

  useEffect(() => {
    if (focus && ready) engine.current?.canvas.focusOn(focus);
  }, [focus, ready]);

  const empty = ready && graph.nodes.length === 0;

  return (
    <div
      className={`graph-view graph:relative graph:h-full graph:w-full graph:overflow-hidden graph:bg-bg graph:font-sans graph:text-text ${
        center ? "graph:min-h-64" : "graph:min-h-96"
      }`}
    >
      <canvas
        ref={canvasRef}
        className="graph:absolute graph:inset-0 graph:block graph:h-full graph:w-full graph:touch-none graph:select-none"
        role="img"
        aria-label={
          center
            ? `Graph of the notes within ${settings.localDepth} links of this one`
            : `Graph of ${graph.nodes.length} notes and ${graph.links.length} links`
        }
      />

      {!ready && <p className="graph:absolute graph:inset-x-0 graph:top-1/2 graph:m-0 graph:text-center graph:text-sm graph:text-text-muted">Indexing…</p>}
      {empty && (
        <p className="graph:absolute graph:inset-x-0 graph:top-1/2 graph:m-0 graph:px-4 graph:text-center graph:text-sm graph:text-text-muted">
          {search ? "No notes match." : "No notes to show yet."}
        </p>
      )}

      {center ? (
        <LocalControls store={store} settings={settings} openGlobal={openGlobal} />
      ) : (
        <Controls
          store={store}
          settings={settings}
          search={search}
          onSearch={setSearch}
          onRecenter={() => engine.current?.canvas.recenter()}
        />
      )}

      {!center && ready && (
        <p className="graph:pointer-events-none graph:absolute graph:bottom-2 graph:left-3 graph:m-0 graph:text-xs graph:text-text-muted">
          {count(graph.nodes.length, "note")} · {count(graph.links.length, "link")}
        </p>
      )}

      <ul className="graph:sr-only">
        {graph.nodes
          .filter((node) => !node.missing)
          .map((node) => (
            <li key={node.id}>
              <button type="button" onClick={() => open(node.id, false)}>
                {node.title || "Untitled"}, {count(node.degree, "link")}
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
