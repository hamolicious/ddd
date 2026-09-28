/**
 * The editor's state: the live wiring, the draft over it, both resolved, the apply plan
 * between them, the selection and the layout. One object per activation, read by the
 * view, the inspector and the graph through `useSyncExternalStore`.
 *
 * - **Previews are local.** `kernel.core.resolveWiring` resolves the draft, `planWiring`
 *   says what applying it does, `wiringCandidates` says what a port could take. Without
 *   the Wasm core those throw, and the editor is read-only (§6).
 * - **Drafts live here** (§10), and in `localStorage` keyed by the server, so a reload
 *   keeps one, together with the live version it started from.
 * - **Live can move.** Every reload compares the server's version with the draft's base;
 *   a newer one rebases the draft's edits on top and says what changed, and a `409` from
 *   Apply does the same.
 * - **Offline is read-only** (§10): the cached live wiring, nothing else.
 */

import {
  CoreUnavailableError,
  splitPortKey,
  type ApplyPlan,
  type CoreApi,
  type InstalledPlugin,
  type LiveWiring,
  type PortCandidate,
  type ProtocolKind,
  type ProtocolPackage,
  type Resolution,
  type ShapeJson,
  type WiringOverrides,
} from "@kernel";

import { EMPTY_WIRING } from "@kernel";

import { statusOf, type ApplyAction, type WiringClient, type WiringVersionInfo } from "./api.js";
import { summarize, type ChangeSummary } from "./changes.js";
import * as Draft from "./draft.js";
import { fit, layout, nodeGeometry, reflow, zoomAt, type Column, type NodeGeometry, type Point, type View } from "./layout.js";
import {
  ProtocolIndex,
  buildGraph,
  dependantCounts,
  focusSet,
  hotPlugins,
  nodeOfPort,
  overridesOf,
  seatedWires,
  wiringInput,
  type Graph,
  type Port,
  type Wire,
} from "./model.js";

export type Selection =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "port"; readonly key: string }
  | { readonly kind: "wire"; readonly key: string }
  | undefined;

export interface Kinds {
  readonly service: boolean;
  readonly slot: boolean;
  readonly event: boolean;
}

export interface LiveMoved {
  readonly from: number;
  readonly to: number;
  readonly changed: readonly string[];
  readonly overlapping: readonly string[];
}

export interface EditorState {
  readonly phase: "loading" | "ready" | "error";
  readonly error?: string;
  readonly plugins: readonly InstalledPlugin[];
  readonly protocolList: readonly ProtocolPackage[];
  readonly protocols: ProtocolIndex;
  readonly live: LiveWiring;
  readonly history: readonly WiringVersionInfo[];
  /** The overrides on screen: the draft, or the live wiring when clean or offline. */
  readonly draft: WiringOverrides;
  readonly draftAction: ApplyAction;
  /** A rollback draft: the version it was loaded from. */
  readonly draftFrom?: number;
  readonly dirty: boolean;
  readonly liveResolution: Resolution;
  readonly resolution: Resolution;
  readonly liveGraph: Graph;
  readonly graph: Graph;
  readonly plan?: ApplyPlan;
  readonly summary?: ChangeSummary;
  /** The Wasm core answered: previews work. */
  readonly core: boolean;
  /** The server has the wiring routes; without them there is nothing to apply to. */
  readonly routes: boolean;
  readonly offline: boolean;
  readonly liveMoved?: LiveMoved;
  readonly busy: boolean;
  readonly notice?: { readonly text: string; readonly bad?: boolean; readonly at: number };
  readonly selection: Selection;
  readonly kinds: Kinds;
  readonly protocolFilter: string;
  /** Focus mode: the plugin whose neighbourhood alone is drawn. View state only. */
  readonly focused: string | undefined;
  readonly geometry: Readonly<Record<string, NodeGeometry>>;
  readonly columns: readonly Column[];
  readonly positions: Readonly<Record<string, Point>>;
  readonly handPlaced: boolean;
  readonly view: View;
  /** The editor cannot change anything right now, and why. */
  readonly readOnly: "offline" | "core" | "routes" | undefined;
}

export interface StoreOptions {
  readonly client: WiringClient;
  readonly core: CoreApi;
  /** This plugin's id: a draft that stops it needs a confirm. */
  readonly editorId: string;
  readonly storageKey: string;
  readonly log: (message: string, ...rest: unknown[]) => void;
}

interface StoredDraft {
  readonly base: number;
  /** The live overrides at `base`, so a draft can be rebased after a reload. */
  readonly baseWiring: WiringOverrides;
  readonly wiring: WiringOverrides;
  readonly action: ApplyAction;
  readonly from?: number;
}

const EMPTY_RESOLUTION: Resolution = {
  order: [],
  skipped: [],
  wires: [],
  bindings: {},
  seats: {},
  bench: {},
  listeners: {},
  activation: [],
  diagnostics: [],
  status: {},
};

export class EditorStore {
  #state: EditorState;
  readonly #listeners = new Set<() => void>();
  #loading: Promise<void> | undefined;
  #noticeTimer: ReturnType<typeof setTimeout> | undefined;
  #reloadedAt = 0;

  constructor(private readonly options: StoreOptions) {
    const protocols = new ProtocolIndex([]);
    const graph = buildGraph([], protocols, EMPTY_RESOLUTION);
    this.#state = {
      phase: "loading",
      plugins: [],
      protocolList: [],
      protocols,
      live: EMPTY_WIRING,
      history: [],
      draft: Draft.EMPTY_OVERRIDES,
      draftAction: "apply",
      dirty: false,
      liveResolution: EMPTY_RESOLUTION,
      resolution: EMPTY_RESOLUTION,
      liveGraph: graph,
      graph,
      core: true,
      routes: true,
      offline: false,
      busy: false,
      selection: undefined,
      kinds: { service: true, slot: true, event: true },
      protocolFilter: "",
      focused: undefined,
      geometry: {},
      columns: [],
      positions: {},
      handPlaced: false,
      view: { x: 20, y: 20, k: 0.6 },
      readOnly: undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  get state(): EditorState {
    return this.#state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getState = (): EditorState => this.#state;

  #set(patch: Partial<EditorState>): void {
    const next = { ...this.#state, ...patch };
    // A focused plugin that leaves the draft, or is unplugged in it, ends focus mode.
    if (next.focused && (!next.graph.byId.has(next.focused) || Draft.isUnplugged(next.draft, next.focused))) next.focused = undefined;
    next.readOnly = next.offline ? "offline" : !next.core ? "core" : !next.routes ? "routes" : undefined;
    this.#state = next;
    for (const listener of [...this.#listeners]) listener();
  }

  dispose(): void {
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = undefined;
    this.#listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /** First load, or a reload when the server may have moved on. Coalesced. */
  load(): Promise<void> {
    if (this.#loading) return this.#loading;
    this.#loading = this.#load().finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  /** A reload no more often than every few seconds: focus and sync transitions call it freely. */
  reloadSoon(): void {
    const now = Date.now();
    if (now - this.#reloadedAt < 3000) return;
    this.#reloadedAt = now;
    void this.load();
  }

  async #load(): Promise<void> {
    const { client } = this.options;
    try {
      const list = await client.plugins();
      let live = list.wiring ?? EMPTY_WIRING;
      let history: readonly WiringVersionInfo[] = [];
      let routes = true;
      try {
        const state = await client.wiring();
        live = state.live;
        history = state.history;
      } catch (error) {
        // A server from before the wiring routes: the plugin list still carries the live
        // wiring, so the graph is drawn; there is just nothing to apply to.
        if (statusOf(error) === 404 || statusOf(error) === 405) routes = false;
        else throw error;
      }
      const protocolList = list.protocols ?? [];
      const protocols = new ProtocolIndex(protocolList);
      const previous = this.#state;
      const first = previous.phase !== "ready";
      // The draft: the one on screen, else the one a reload left behind.
      let draft = previous.dirty ? previous.draft : undefined;
      let draftAction = previous.draftAction;
      let draftFrom = previous.draftFrom;
      let base = previous.live.version;
      let baseWiring = overridesOf(previous.live);
      if (first) {
        const stored = this.#readStored();
        if (stored) {
          draft = stored.wiring;
          draftAction = stored.action;
          draftFrom = stored.from;
          base = stored.base;
          baseWiring = stored.baseWiring;
        }
      }
      let liveMoved: LiveMoved | undefined = first ? undefined : previous.liveMoved;
      if (draft && live.version !== base) {
        const rebased = Draft.rebase(baseWiring, draft, live);
        draft = rebased.draft;
        liveMoved = { from: base, to: live.version, changed: rebased.liveChanged, overlapping: rebased.overlapping };
      }
      if (draft && Draft.sameOverrides(draft, live)) {
        draft = undefined;
        liveMoved = undefined;
      }

      const { resolution: liveResolution, core } = this.#resolve(list.plugins, protocolList, live, list.resolved?.normal);
      const shown = draft ?? overridesOf(live);
      const resolution = draft && core ? this.#resolve(list.plugins, protocolList, shown).resolution : liveResolution;
      const liveGraph = buildGraph(list.plugins, protocols, liveResolution);
      const graph = draft ? buildGraph(list.plugins, protocols, resolution) : liveGraph;
      const plan = draft && core ? this.#plan(list.plugins, liveResolution, resolution, overridesOf(live), shown) : undefined;
      const summary = plan ? summarize(plan, overridesOf(live), shown, this.options.editorId) : undefined;

      this.#set({
        phase: "ready",
        error: undefined,
        plugins: list.plugins,
        protocolList,
        protocols,
        live,
        history,
        draft: shown,
        draftAction: draft ? draftAction : "apply",
        draftFrom: draft ? draftFrom : undefined,
        dirty: draft !== undefined,
        liveResolution,
        resolution,
        liveGraph,
        graph,
        plan,
        summary,
        core,
        routes,
        liveMoved,
        ...(first ? { focused: undefined } : {}),
      });
      this.#writeStored();
      this.#relayout(first || previous.live.version !== live.version);
      if (liveMoved && !first) this.notice(`live moved to v${live.version}${liveMoved.overlapping.length ? `, ${liveMoved.overlapping.length} of your edits overlap` : ""}`);
    } catch (error) {
      this.#set({ phase: this.#state.phase === "ready" ? "ready" : "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  #resolve(
    plugins: readonly InstalledPlugin[],
    protocols: readonly ProtocolPackage[],
    wiring: WiringOverrides,
    fallback?: Resolution,
  ): { readonly resolution: Resolution; readonly core: boolean } {
    try {
      return { resolution: this.options.core.resolveWiring(wiringInput(plugins, protocols, wiring)), core: true };
    } catch (error) {
      if (!(error instanceof CoreUnavailableError)) this.options.log("the resolver failed", error);
      return { resolution: fallback ?? this.#state.liveResolution, core: false };
    }
  }

  #plan(
    plugins: readonly InstalledPlugin[],
    before: Resolution,
    after: Resolution,
    beforeWiring: WiringOverrides,
    afterWiring: WiringOverrides,
  ): ApplyPlan | undefined {
    try {
      return this.options.core.planWiring({ before, after, beforeWiring, afterWiring, hot: hotPlugins(plugins) });
    } catch (error) {
      this.options.log("the plan failed", error);
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------

  /** Replace the draft and re-resolve. The one path every edit takes. */
  #setDraft(next: WiringOverrides, action: ApplyAction = "apply", from?: number): void {
    const s = this.#state;
    if (s.readOnly) return;
    const live = overridesOf(s.live);
    const clean = Draft.sameOverrides(next, live);
    const shown = clean ? live : Draft.normalize(next);
    const resolution = clean ? s.liveResolution : this.#resolve(s.plugins, s.protocolList, shown).resolution;
    const graph = clean ? s.liveGraph : buildGraph(s.plugins, s.protocols, resolution);
    const plan = clean ? undefined : this.#plan(s.plugins, s.liveResolution, resolution, live, shown);
    this.#set({
      draft: shown,
      dirty: !clean,
      draftAction: clean ? "apply" : action,
      draftFrom: clean ? undefined : from,
      resolution,
      graph,
      plan,
      summary: plan ? summarize(plan, live, shown, this.options.editorId) : undefined,
      liveMoved: clean ? undefined : s.liveMoved,
    });
    this.#writeStored();
    this.#relayout(false);
  }

  togglePlug(plugin: string): void {
    const s = this.#state;
    if (s.readOnly) return this.notice("read-only", true);
    const was = Draft.isUnplugged(s.draft, plugin);
    this.#setDraft(Draft.togglePlug(s.draft, plugin));
    this.select({ kind: "node", id: plugin });
    const plan = this.#state.plan;
    const extra = plan ? (was ? plan.alsoStarts : plan.alsoStops).filter((id) => id !== plugin) : [];
    this.notice(
      was
        ? `plugged in ${plugin}${extra.length ? ` · +${extra.length}` : ""}`
        : `unplugged ${plugin}${extra.length ? ` · also stops ${extra.slice(0, 3).join(", ")}${extra.length > 3 ? "…" : ""}` : ""}`,
    );
  }

  /** What a port could be wired to, from the resolver. Empty without the core. */
  candidates(port: string, dir: "in" | "out"): readonly PortCandidate[] {
    const s = this.#state;
    if (!s.core) return [];
    try {
      return this.options.core.wiringCandidates(wiringInput(s.plugins, s.protocolList, s.draft), port, dir);
    } catch {
      return [];
    }
  }

  /** Why `offer` does not fit `need`; empty when it does. */
  shapeFits(offer: ShapeJson, need: ShapeJson): readonly string[] {
    try {
      return this.options.core.shapeFits(offer, need);
    } catch {
      return [];
    }
  }

  /**
   * Wire a provided port to a consumed port. By-shape wires across protocols ask first
   * (§10), through `confirm`; the caller supplies it so the store stays free of the menu.
   */
  async connect(from: string, to: string, confirm: (offerProtocol: string, needProtocol: string) => Promise<boolean>): Promise<void> {
    const s = this.#state;
    if (s.readOnly) return this.notice("read-only", true);
    const offer = s.graph.ports.get(from);
    const need = s.graph.ports.get(to);
    if (!offer || !need) return;
    const off = [offer.plugin, need.plugin].find((id) => Draft.isUnplugged(s.draft, id));
    if (off) return this.notice(`${off} is unplugged`, true);
    const candidate = this.candidates(to, "in").find((c) => c.port === from);
    if (!candidate || !candidate.ok) {
      return this.notice(`does not fit ${to}${candidate?.reasons.length ? `: ${candidate.reasons.slice(0, 2).join("; ")}` : ""}`, true);
    }
    if (need.kind !== "slot" && !candidate.same) return this.notice(`${need.kind}s wire only within one protocol`, true);
    if (!candidate.same && !(await confirm(offer.protocol, need.protocol))) return;
    if (this.#state !== s && this.#state.readOnly) return;
    const current = seatedWires(s.graph, to).map((wire) => wire.from);
    const outcome = Draft.connect(s.draft, {
      from,
      to,
      kind: need.kind,
      auto: candidate.auto,
      current,
      single: need.seats === 1,
      ...(need.kind === "service" ? { autoChoice: this.#autoChoice(to) } : {}),
    });
    if (!outcome.ok) return this.notice(outcome.reason, true);
    this.#setDraft(outcome.overrides);
    if (need.kind === "slot") {
      this.select({ kind: "port", key: to });
      this.notice(`${offer.plugin} took seat ${outcome.seat} on ${to}${outcome.benched ? `; ${nodeOfPort(outcome.benched)} benched` : ""}`);
    } else {
      this.select({ kind: "wire", key: `${from} -> ${to}` });
      this.notice(need.kind === "service" ? `${to} now uses ${offer.plugin}` : `wired ${from} → ${to}`);
    }
  }

  /**
   * A consumed service's `bind` entry, set directly: `undefined` removes it (automatic),
   * `null` binds to nothing (an optional port), a port key pins that provider. A pin must
   * be a same-protocol candidate that fits (§6b: services never wire by shape).
   */
  bind(port: string, to: string | null | undefined): void {
    const s = this.#state;
    if (s.readOnly) return this.notice("read-only", true);
    if (typeof to === "string") {
      if (Draft.isUnplugged(s.draft, nodeOfPort(to))) return this.notice(`${nodeOfPort(to)} is unplugged`, true);
      const candidate = this.candidates(port, "in").find((c) => c.port === to);
      if (!candidate || !candidate.ok || !candidate.same) {
        return this.notice(`does not fit ${port}${candidate?.reasons.length ? `: ${candidate.reasons.slice(0, 2).join("; ")}` : ""}`, true);
      }
    }
    const bind = { ...s.draft.bind };
    if (to === undefined) delete bind[port];
    else bind[port] = to;
    this.#setDraft({ ...s.draft, bind });
    this.notice(to === undefined ? `${port}: automatic` : to === null ? `${port}: none` : `${port} now uses ${nodeOfPort(to)}`);
  }

  /** The resolver's own pick for a service port with no pin, and whether there was a choice. */
  #autoChoice(port: string): { readonly port: string | undefined; readonly several: boolean } {
    const s = this.#state;
    const bind = { ...s.draft.bind };
    delete bind[port];
    const { resolution } = this.#resolve(s.plugins, s.protocolList, { ...s.draft, bind });
    const status = resolution.status[port];
    return { port: resolution.bindings[port], several: status?.code === "providers" || status?.code === "pinned" };
  }

  cutWire(key: string): void {
    const s = this.#state;
    if (s.readOnly) return this.notice("read-only", true);
    const wire = s.graph.wires.find((w) => w.key === key);
    if (!wire) return;
    this.#setDraft(Draft.cut(s.draft, wire));
    this.select(wire.kind === "slot" ? { kind: "port", key: wire.to } : { kind: "node", id: wire.toNode });
    this.notice(`cut ${wire.from} → ${wire.to}`);
  }

  moveSeat(host: string, from: string, delta: -1 | 1): void {
    const s = this.#state;
    if (s.readOnly) return this.notice("read-only", true);
    const current = seatedWires(s.graph, host)
      .filter((wire) => !wire.bench)
      .map((wire) => wire.from);
    this.#setDraft(Draft.moveSeat(s.draft, host, current, from, delta));
    this.select({ kind: "port", key: host });
  }

  resetOrder(host: string): void {
    if (this.#state.readOnly) return this.notice("read-only", true);
    this.#setDraft(Draft.resetOrder(this.#state.draft, host));
    this.select({ kind: "port", key: host });
  }

  resetToAutomatic(): void {
    if (this.#state.readOnly) return this.notice("read-only", true);
    this.#setDraft(Draft.resetToAutomatic(this.#state.draft));
    this.select(undefined);
    this.notice("automatic wiring · unplugged plugins stay");
  }

  discard(): void {
    if (!this.#state.dirty) return;
    this.#setDraft(overridesOf(this.#state.live));
    this.#set({ liveMoved: undefined });
    this.select(undefined);
    this.notice("draft discarded");
  }

  /** An old version as a draft on top of the current live base; Apply then rolls back. */
  async loadVersion(version: number): Promise<void> {
    const s = this.#state;
    if (s.readOnly) return this.notice("read-only", true);
    try {
      const stored = await this.options.client.version(version);
      this.#setDraft(stored.wiring, "rollback", version);
      this.select(undefined);
      this.notice(this.#state.dirty ? `v${version} loaded as a draft` : `v${version} is the live wiring`);
    } catch (error) {
      this.notice(error instanceof Error ? error.message : String(error), true);
    }
  }

  /**
   * Commit the draft as the next version. `confirm` is asked when the draft adds errors or
   * stops the editor itself (§6c), naming the way back. A stale base reloads and rebases.
   */
  async apply(confirm: (summary: ChangeSummary, version: number) => Promise<boolean>): Promise<void> {
    const s = this.#state;
    if (!s.dirty || s.busy) return;
    if (s.readOnly) return this.notice("read-only", true);
    const summary = s.summary;
    if (summary && (summary.addedErrors > 0 || summary.stopsEditor) && !(await confirm(summary, s.live.version))) return;
    this.#set({ busy: true });
    try {
      const result = await this.options.client.apply({ base: s.live.version, wiring: Draft.normalize(s.draft), action: s.draftAction });
      if (result.kind === "stale") {
        this.#set({ busy: false });
        await this.load();
        this.notice(`live moved to v${this.#state.live.version}; check the draft and apply again`, true);
        return;
      }
      const live = result.live;
      const { resolution } = this.#resolve(s.plugins, s.protocolList, live);
      const graph = buildGraph(s.plugins, s.protocols, resolution);
      this.#set({
        busy: false,
        live,
        draft: overridesOf(live),
        dirty: false,
        draftAction: "apply",
        draftFrom: undefined,
        liveResolution: resolution,
        resolution,
        liveGraph: graph,
        graph,
        plan: undefined,
        summary: undefined,
        liveMoved: undefined,
      });
      this.#writeStored();
      this.#relayout(true);
      this.notice(`applied v${live.version}${summary?.cold.length ? ` · reload needed for ${summary.cold.join(", ")}` : ""}`);
      // The history list is the server's; fetch it fresh rather than guess at the row.
      this.#reloadedAt = 0;
      void this.load();
    } catch (error) {
      this.#set({ busy: false });
      this.notice(error instanceof Error ? error.message : String(error), true);
    }
  }

  // -------------------------------------------------------------------------
  // Connectivity
  // -------------------------------------------------------------------------

  setOffline(offline: boolean): void {
    if (offline === this.#state.offline) return;
    const s = this.#state;
    if (offline) {
      // Cached live wiring, nothing else: the draft is kept in storage for when sync returns.
      this.#set({
        offline: true,
        draft: overridesOf(s.live),
        dirty: false,
        resolution: s.liveResolution,
        graph: s.liveGraph,
        plan: undefined,
        summary: undefined,
        selection: undefined,
      });
      return;
    }
    this.#set({ offline: false });
    const stored = this.#readStored();
    if (stored && stored.base === s.live.version) this.#setDraft(stored.wiring, stored.action, stored.from);
    this.reloadSoon();
  }

  // -------------------------------------------------------------------------
  // Selection and view
  // -------------------------------------------------------------------------

  select(selection: Selection): void {
    this.#set({ selection });
  }

  setKinds(kinds: Kinds): void {
    this.#set({ kinds });
  }

  setProtocolFilter(protocolFilter: string): void {
    this.#set({ protocolFilter });
  }

  setView(view: View): void {
    this.#set({ view });
  }

  zoom(factor: number, px: number, py: number): void {
    this.#set({ view: zoomAt(this.#state.view, factor, px, py) });
  }

  /** Fit the nodes on screen: all of them, or the focused neighbourhood. */
  fit(width: number, height: number): void {
    const s = this.#state;
    const shown = this.focusSet();
    const heights = Object.fromEntries(Object.entries(s.geometry).map(([id, g]) => [id, g.height]));
    const positions = shown ? Object.fromEntries(Object.entries(s.positions).filter(([id]) => shown.has(id))) : s.positions;
    this.#set({ view: fit(positions, heights, width, height) });
  }

  /** Focus mode on `id`, fitted to the canvas; positions stay as the full layout has them. */
  focusOn(id: string, width: number, height: number): void {
    const s = this.#state;
    if (!s.graph.byId.has(id) || Draft.isUnplugged(s.draft, id)) return;
    this.#set({ focused: id });
    this.fit(width, height);
  }

  unfocus(): void {
    if (this.#state.focused) this.#set({ focused: undefined });
  }

  /** The nodes focus mode draws, with the kind and protocol filters on top; `undefined` when not focused. */
  focusSet(): ReadonlySet<string> | undefined {
    const s = this.#state;
    return s.focused ? focusSet(s.focused, s.graph.wires, s.kinds, s.protocolFilter) : undefined;
  }

  /** Columns from scratch: load, Apply and Tidy. Tidy also leaves focus mode. */
  tidy(): void {
    this.#set({ handPlaced: false, focused: undefined });
    this.#relayout(true);
  }

  moveNode(id: string, to: Point): void {
    this.#set({ positions: { ...this.#state.positions, [id]: to }, handPlaced: true });
  }

  #relayout(fresh: boolean): void {
    const s = this.#state;
    const geometry = Object.fromEntries(s.graph.nodes.map((node) => [node.id, nodeGeometry(node, s.graph.seatCount)]));
    const heights = Object.fromEntries(Object.entries(geometry).map(([id, g]) => [id, g.height]));
    if (s.handPlaced && !fresh) {
      this.#set({ geometry });
      return;
    }
    const known = s.columns.flatMap((column) => column.ids);
    const complete = !fresh && known.length === s.graph.nodes.length && s.graph.nodes.every((node) => known.includes(node.id));
    if (complete) {
      this.#set({ geometry, positions: reflow(s.columns, s.positions, heights) });
      return;
    }
    const counts = dependantCounts(s.graph.nodes, s.graph.wires);
    const placed = layout(s.graph.nodes, heights, counts);
    this.#set({ geometry, columns: placed.columns, positions: placed.positions, handPlaced: false });
  }

  /** Dependant counts of the graph on screen, for the titles and column labels. */
  counts(): Readonly<Record<string, number>> {
    return dependantCounts(this.#state.graph.nodes, this.#state.graph.wires);
  }

  // -------------------------------------------------------------------------
  // Small helpers the views share
  // -------------------------------------------------------------------------

  notice(text: string, bad = false): void {
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.#set({ notice: { text, bad, at: Date.now() } });
    this.#noticeTimer = setTimeout(() => {
      this.#noticeTimer = undefined;
      this.#set({ notice: undefined });
    }, 3200);
  }

  port(key: string): Port | undefined {
    return this.#state.graph.ports.get(key);
  }

  wire(key: string): Wire | undefined {
    return this.#state.graph.wires.find((wire) => wire.key === key);
  }

  kindOf(protocol: string): ProtocolKind | undefined {
    return this.#state.protocols.kindOf(protocol);
  }

  /** The `wiring.json` view: the draft as the next version, or the live one. */
  wiringJson(): string {
    const s = this.#state;
    return JSON.stringify({ version: s.dirty ? s.live.version + 1 : s.live.version, ...Draft.normalize(s.draft) }, null, 2);
  }

  /** A plugin is out of the draft's activation: unplugged, or skipped by the resolver. */
  nodeState(id: string): "unplugged" | "skipped" | "active" {
    const s = this.#state;
    if (Draft.isUnplugged(s.draft, id)) return "unplugged";
    if (s.resolution.skipped.some((entry) => entry.plugin === id)) return "skipped";
    return "active";
  }

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------

  #readStored(): StoredDraft | undefined {
    try {
      const raw = localStorage.getItem(this.options.storageKey);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Partial<StoredDraft>;
      if (typeof parsed.base !== "number" || !parsed.wiring) return undefined;
      return {
        base: parsed.base,
        baseWiring: Draft.normalize({ ...Draft.EMPTY_OVERRIDES, ...parsed.baseWiring }),
        wiring: Draft.normalize({ ...Draft.EMPTY_OVERRIDES, ...parsed.wiring }),
        action: parsed.action === "rollback" ? "rollback" : "apply",
        ...(typeof parsed.from === "number" ? { from: parsed.from } : {}),
      };
    } catch {
      return undefined;
    }
  }

  #writeStored(): void {
    const s = this.#state;
    try {
      if (!s.dirty) localStorage.removeItem(this.options.storageKey);
      else {
        const stored: StoredDraft = {
          base: s.live.version,
          baseWiring: overridesOf(s.live),
          wiring: s.draft,
          action: s.draftAction,
          ...(s.draftFrom !== undefined ? { from: s.draftFrom } : {}),
        };
        localStorage.setItem(this.options.storageKey, JSON.stringify(stored));
      }
    } catch {
      // Storage is a convenience: a private window without it still edits.
    }
  }
}

/** The plugin id a port key names, for links. */
export const pluginOf = (key: string): string => splitPortKey(key)[0];
