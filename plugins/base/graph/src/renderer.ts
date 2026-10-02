import type { DocumentId } from "@kernel";

import { groupOf, type Graph, type GraphNode } from "./model.js";
import type { SimNode, Simulation } from "./simulation.js";

export interface Display {
  readonly arrows: boolean;
  readonly sizeByLinks: boolean;
  readonly textFade: number;
  readonly nodeSize: number;
  readonly linkThickness: number;
  readonly colorByFolder: boolean;
}

export const DEFAULT_DISPLAY: Display = {
  arrows: false,
  sizeByLinks: true,
  textFade: 0,
  nodeSize: 1,
  linkThickness: 1,
  colorByFolder: true,
};

export interface CanvasEvents {
  open(id: DocumentId, newTab: boolean): void;
}

interface Palette {
  node: string;
  missing: string;
  link: string;
  accent: string;
  text: string;
  halo: string;
  font: string;
}

interface Camera {
  x: number;
  y: number;
  k: number;
}

const GROUP_COLOURS = ["#e0795b", "#d4a13c", "#7fae52", "#3fa7a0", "#5a8fd8", "#8f72d6", "#c966a8", "#9c8a78"];

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 6;
const CLICK_SLOP = 4;
const FADE_MS = 160;
const DIMMED = 0.15;
const LABEL_FONT = 12;
const APPEAR_MS = 350;
const CONNECTION_LABEL_LEAD = 0.12;
const FOCUS_DELAY_MS = 900;
const FOCUS_ALPHA = 0.25;
const FOCUS_ZOOM = 1.6;

interface Gesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  readonly node: SimNode | undefined;
  moved: boolean;
}

export class GraphCanvas {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #sim: Simulation;
  readonly #events: CanvasEvents;
  #display: Display = DEFAULT_DISPLAY;
  #info = new Map<DocumentId, GraphNode>();
  #neighbours = new Map<DocumentId, Set<DocumentId>>();
  #groups = new Map<string, string>();
  #highlight: DocumentId | undefined;
  #palette: Palette | undefined;

  #width = 0;
  #height = 0;
  #ratio = 1;
  #camera: Camera = { x: 0, y: 0, k: 1 };
  #steered = false;
  #focusRequest: { readonly id: DocumentId; readonly at: number } | undefined;
  #zoomTo: DocumentId | undefined;
  #anchor: DocumentId | undefined;
  #born = new Map<DocumentId, number>();
  #ghosts: Array<{ readonly x: number; readonly y: number; readonly radius: number; readonly colour: string; readonly at: number }> = [];
  #fadesUntil = 0;

  #hover: SimNode | undefined;
  #focus: SimNode | undefined;
  #fade = 0;

  #gestures = new Map<number, Gesture>();
  #pinch: { distance: number } | undefined;

  #frame: number | undefined;
  #lastTime = 0;
  readonly #resize: ResizeObserver;
  readonly #cleanup: Array<() => void> = [];

  constructor(canvas: HTMLCanvasElement, sim: Simulation, events: CanvasEvents) {
    this.#canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("graph: no 2D canvas context");
    this.#context = context;
    this.#sim = sim;
    this.#events = events;

    this.#resize = new ResizeObserver(() => this.#measure());
    this.#resize.observe(canvas);
    this.#measure();

    this.#listen("pointerdown", (event) => this.#down(event));
    this.#listen("pointermove", (event) => this.#move(event));
    this.#listen("pointerup", (event) => this.#up(event));
    this.#listen("pointercancel", (event) => this.#up(event, true));
    this.#listen("pointerleave", (event) => {
      if (event.pointerType === "mouse" && this.#gestures.size === 0) this.#setHover(undefined);
    });
    this.#listen("wheel", (event) => this.#wheel(event), { passive: false });
    this.#listen("mousedown", (event) => {
      if (event.button === 1) event.preventDefault();
    });

    const scheme = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    const repaint = (): void => this.wake();
    scheme?.addEventListener("change", repaint);
    this.#cleanup.push(() => scheme?.removeEventListener("change", repaint));
    const observer = new MutationObserver(repaint);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-ddd-scheme"] });
    this.#cleanup.push(() => observer.disconnect());
  }

  destroy(): void {
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    this.#resize.disconnect();
    for (const cleanup of this.#cleanup) cleanup();
  }

  setGraph(graph: Graph, leaving: readonly SimNode[] = []): void {
    const now = performance.now();
    const palette = (this.#palette ??= this.#readPalette());
    for (const node of leaving) {
      this.#ghosts.push({ x: node.x, y: node.y, radius: this.#radius(node), colour: this.#colour(node, palette), at: now });
      this.#born.delete(node.id);
    }
    for (const node of graph.nodes) if (!this.#born.has(node.id)) this.#born.set(node.id, now);
    if (leaving.length > 0 || graph.nodes.some((node) => this.#born.get(node.id) === now)) {
      this.#fadesUntil = now + APPEAR_MS;
    }
    this.#info = new Map(graph.nodes.map((node) => [node.id, node]));
    this.#neighbours = new Map();
    for (const { source, target } of graph.links) {
      (this.#neighbours.get(source) ?? this.#neighbours.set(source, new Set()).get(source)!).add(target);
      (this.#neighbours.get(target) ?? this.#neighbours.set(target, new Set()).get(target)!).add(source);
    }
    const groups = [...new Set(graph.nodes.filter((node) => !node.missing).map(groupOf))].filter(Boolean).sort();
    this.#groups = new Map(groups.map((group, index) => [group, GROUP_COLOURS[index % GROUP_COLOURS.length]!]));
    if (this.#hover && !this.#info.has(this.#hover.id)) this.#setHover(undefined);
    if (this.#focus && !this.#info.has(this.#focus.id)) this.#focus = undefined;
    this.wake();
  }

  setDisplay(display: Display): void {
    this.#display = display;
    this.wake();
  }

  setAnchor(id: DocumentId | undefined): void {
    if (id === this.#anchor) return;
    this.#anchor = id;
    this.#steered = false;
    this.#stopFocus();
    this.wake();
  }

  setHighlight(id: DocumentId | undefined): void {
    this.#highlight = id;
    this.wake();
  }

  focusOn(id: DocumentId): void {
    this.#focusRequest = { id, at: performance.now() };
    this.#zoomTo = undefined;
    this.wake();
  }

  recenter(): void {
    this.#steered = false;
    this.#stopFocus();
    this.#sim.reheat(0.1);
    this.wake();
  }

  wake(): void {
    this.#palette = undefined;
    if (this.#frame !== undefined) return;
    this.#lastTime = performance.now();
    this.#frame = requestAnimationFrame((time) => this.#tick(time));
  }

  #tick(time: number): void {
    this.#frame = undefined;
    const elapsed = Math.min(64, time - this.#lastTime);
    this.#lastTime = time;

    if (this.#sim.running) this.#sim.tick();

    const fadeTarget = this.#hover ? 1 : 0;
    if (this.#fade !== fadeTarget) {
      const step = elapsed / FADE_MS;
      this.#fade = fadeTarget > this.#fade ? Math.min(1, this.#fade + step) : Math.max(0, this.#fade - step);
      if (this.#fade === 0) this.#focus = undefined;
    }

    const request = this.#focusRequest;
    if (request) {
      if (!this.#sim.node(request.id)) this.#focusRequest = undefined;
      else if (time - request.at > FOCUS_DELAY_MS && this.#sim.alpha < FOCUS_ALPHA) {
        this.#focusRequest = undefined;
        this.#zoomTo = request.id;
        this.#steered = true;
      }
    }

    const cameraMoving = this.#zoomTo !== undefined ? this.#track(elapsed) : !this.#steered && this.#follow(elapsed);

    this.#draw();

    if (
      this.#sim.running ||
      this.#fade !== fadeTarget ||
      cameraMoving ||
      this.#gestures.size > 0 ||
      this.#focusRequest !== undefined ||
      time < this.#fadesUntil
    ) {
      this.#frame = requestAnimationFrame((next) => this.#tick(next));
    }
  }

  #follow(elapsed: number): boolean {
    const nodes = this.#sim.nodes;
    if (nodes.length === 0 || this.#width === 0) return false;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const node of nodes) {
      if (node.x < x0) x0 = node.x;
      if (node.y < y0) y0 = node.y;
      if (node.x > x1) x1 = node.x;
      if (node.y > y1) y1 = node.y;
    }
    const pad = 48;
    const anchor = this.#anchor === undefined ? undefined : this.#sim.node(this.#anchor);
    const middle = anchor ? { x: anchor.x, y: anchor.y } : { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    const spanX = anchor ? 2 * Math.max(anchor.x - x0, x1 - anchor.x) : x1 - x0;
    const spanY = anchor ? 2 * Math.max(anchor.y - y0, y1 - anchor.y) : y1 - y0;
    const k = clamp(
      Math.min((this.#width - pad * 2) / Math.max(spanX, 1), (this.#height - pad * 2) / Math.max(spanY, 1)),
      MIN_ZOOM,
      1.5,
    );
    const target = { x: middle.x, y: middle.y, k };
    const ease = 1 - Math.pow(0.001, elapsed / 1000);
    const camera = this.#camera;
    camera.x += (target.x - camera.x) * ease;
    camera.y += (target.y - camera.y) * ease;
    camera.k *= Math.pow(target.k / camera.k, ease);
    return (
      Math.abs(target.x - camera.x) * camera.k > 0.5 ||
      Math.abs(target.y - camera.y) * camera.k > 0.5 ||
      Math.abs(target.k / camera.k - 1) > 0.002
    );
  }

  #track(elapsed: number): boolean {
    const node = this.#zoomTo === undefined ? undefined : this.#sim.node(this.#zoomTo);
    if (!node) {
      this.#zoomTo = undefined;
      return false;
    }
    const camera = this.#camera;
    const k = Math.max(camera.k, FOCUS_ZOOM);
    const ease = 1 - Math.pow(0.03, elapsed / 1000);
    camera.x += (node.x - camera.x) * ease;
    camera.y += (node.y - camera.y) * ease;
    camera.k *= Math.pow(k / camera.k, ease);
    const moving =
      Math.abs(node.x - camera.x) * camera.k > 0.5 ||
      Math.abs(node.y - camera.y) * camera.k > 0.5 ||
      Math.abs(k / camera.k - 1) > 0.002;
    if (!moving && !this.#sim.running) this.#zoomTo = undefined;
    return moving;
  }

  #stopFocus(): void {
    this.#focusRequest = undefined;
    this.#zoomTo = undefined;
  }

  #measure(): void {
    const rect = this.#canvas.getBoundingClientRect();
    this.#ratio = globalThis.devicePixelRatio || 1;
    this.#width = rect.width;
    this.#height = rect.height;
    this.#canvas.width = Math.max(1, Math.round(rect.width * this.#ratio));
    this.#canvas.height = Math.max(1, Math.round(rect.height * this.#ratio));
    this.wake();
  }

  #readPalette(): Palette {
    const style = getComputedStyle(this.#canvas);
    const token = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
    return {
      node: token("--ddd-text-muted", "#888"),
      missing: token("--ddd-border-strong", "#aaa"),
      link: token("--ddd-border-strong", "#bbb"),
      accent: token("--ddd-accent", "#7c5cff"),
      text: token("--ddd-text", "#222"),
      halo: token("--ddd-bg", "#fff"),
      font: token("--ddd-font-sans", "sans-serif"),
    };
  }

  #radius(node: SimNode): number {
    const grown = this.#display.sizeByLinks ? Math.sqrt(node.degree) * 2.2 : 0;
    return Math.max((4 + grown) * this.#display.nodeSize, 2 / this.#camera.k);
  }

  #colour(node: SimNode, palette: Palette): string {
    const info = this.#info.get(node.id);
    if (!info || info.missing) return palette.missing;
    if (this.#display.colorByFolder) return this.#groups.get(groupOf(info)) ?? palette.node;
    return palette.node;
  }

  #lit(id: DocumentId): boolean {
    const focus = this.#focus;
    return !focus || focus.id === id || Boolean(this.#neighbours.get(focus.id)?.has(id));
  }

  #draw(): void {
    const palette = (this.#palette ??= this.#readPalette());
    const context = this.#context;
    const { x, y, k } = this.#camera;
    const fade = this.#fade;
    const dim = 1 - (1 - DIMMED) * fade;
    const focus = this.#focus;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    context.setTransform(
      this.#ratio * k,
      0,
      0,
      this.#ratio * k,
      this.#ratio * (this.#width / 2 - x * k),
      this.#ratio * (this.#height / 2 - y * k),
    );

    const width = Math.max(0.5 / k, 1 * this.#display.linkThickness);
    context.lineWidth = width;
    context.strokeStyle = palette.link;
    context.globalAlpha = 0.6 * (focus ? dim : 1);
    context.beginPath();
    const lit: SimNode[][] = [];
    const now = performance.now();
    const arriving: Array<[SimNode, SimNode, number]> = [];
    for (const { source, target } of this.#sim.links) {
      if (focus && (source === focus || target === focus)) {
        lit.push([source, target]);
        continue;
      }
      const appear = Math.min(this.#appear(source.id, now), this.#appear(target.id, now));
      if (appear < 1) {
        arriving.push([source, target, appear]);
        continue;
      }
      context.moveTo(source.x, source.y);
      context.lineTo(target.x, target.y);
    }
    context.stroke();
    const linkAlpha = context.globalAlpha;
    for (const [source, target, appear] of arriving) {
      context.globalAlpha = linkAlpha * appear;
      context.beginPath();
      context.moveTo(source.x, source.y);
      context.lineTo(target.x, target.y);
      context.stroke();
    }
    context.globalAlpha = linkAlpha;
    if (this.#display.arrows) {
      context.fillStyle = palette.link;
      for (const { source, target } of this.#sim.links) {
        if (focus && (source === focus || target === focus)) continue;
        this.#arrow(source, target, width);
      }
    }
    if (lit.length > 0) {
      context.globalAlpha = 0.6 + 0.4 * fade;
      context.strokeStyle = palette.accent;
      context.fillStyle = palette.accent;
      context.lineWidth = width * (1 + fade * 0.6);
      context.beginPath();
      for (const [source, target] of lit) {
        context.moveTo(source!.x, source!.y);
        context.lineTo(target!.x, target!.y);
      }
      context.stroke();
      if (this.#display.arrows) for (const [source, target] of lit) this.#arrow(source!, target!, width);
    }

    this.#ghosts = this.#ghosts.filter((ghost) => now - ghost.at < APPEAR_MS);
    for (const ghost of this.#ghosts) {
      context.globalAlpha = 1 - (now - ghost.at) / APPEAR_MS;
      context.fillStyle = ghost.colour;
      context.beginPath();
      context.arc(ghost.x, ghost.y, ghost.radius, 0, Math.PI * 2);
      context.fill();
    }
    for (const node of this.#sim.nodes) {
      const info = this.#info.get(node.id);
      const appear = this.#appear(node.id, now);
      const radius = this.#radius(node) * (0.5 + 0.5 * appear);
      context.globalAlpha = (this.#lit(node.id) ? 1 : dim) * appear;
      const hovered = node === focus && fade > 0;
      context.beginPath();
      context.arc(node.x, node.y, radius, 0, Math.PI * 2);
      if (info?.missing) {
        context.lineWidth = Math.max(1, radius * 0.3);
        context.strokeStyle = hovered ? palette.accent : palette.missing;
        context.stroke();
      } else {
        context.fillStyle = hovered ? palette.accent : this.#colour(node, palette);
        context.fill();
      }
      if (node.id === this.#highlight) {
        context.beginPath();
        context.arc(node.x, node.y, radius + 3, 0, Math.PI * 2);
        context.lineWidth = 2;
        context.strokeStyle = palette.accent;
        context.stroke();
      }
    }

    const fontSize = LABEL_FONT / Math.max(k, 0.6);
    context.font = `${fontSize}px ${palette.font}`;
    context.textAlign = "center";
    context.textBaseline = "top";
    context.lineJoin = "round";
    for (const node of this.#sim.nodes) {
      const info = this.#info.get(node.id);
      if (!info) continue;
      const zoomAlpha = labelZoomAlpha(k, this.#display.textFade, node.degree);
      const inFocus = Boolean(focus) && this.#lit(node.id);
      const always = node.id === this.#highlight || (inFocus && fade > 0);
      let alpha = always ? Math.max(zoomAlpha, focus ? fade : 1) : zoomAlpha * (this.#lit(node.id) ? 1 : dim);
      if (alpha <= 0.02) continue;
      alpha = Math.min(1, alpha);
      const label = truncate(info.missing ? `${info.title.slice(0, 8)}…` : info.title || "Untitled");
      const top = node.y + this.#radius(node) + 3;
      context.globalAlpha = alpha;
      context.lineWidth = 3 / Math.max(k, 0.6);
      context.strokeStyle = palette.halo;
      context.strokeText(label, node.x, top);
      context.fillStyle = palette.text;
      context.fillText(label, node.x, top);
    }
    context.globalAlpha = 1;
  }

  #appear(id: DocumentId, now: number): number {
    const born = this.#born.get(id);
    return born === undefined ? 1 : Math.min(1, (now - born) / APPEAR_MS);
  }

  #arrow(source: SimNode, target: SimNode, width: number): void {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) return;
    const ux = dx / length;
    const uy = dy / length;
    const tipX = target.x - ux * (this.#radius(target) + 1);
    const tipY = target.y - uy * (this.#radius(target) + 1);
    const size = Math.max(4, width * 4);
    const context = this.#context;
    context.beginPath();
    context.moveTo(tipX, tipY);
    context.lineTo(tipX - ux * size - uy * size * 0.5, tipY - uy * size + ux * size * 0.5);
    context.lineTo(tipX - ux * size + uy * size * 0.5, tipY - uy * size - ux * size * 0.5);
    context.closePath();
    context.fill();
  }

  #listen<K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    this.#canvas.addEventListener(type, handler, options);
    this.#cleanup.push(() => this.#canvas.removeEventListener(type, handler, options));
  }

  #local(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.#canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  #toWorld(point: { x: number; y: number }): { x: number; y: number } {
    const { x, y, k } = this.#camera;
    return { x: (point.x - this.#width / 2) / k + x, y: (point.y - this.#height / 2) / k + y };
  }

  #nodeAt(point: { x: number; y: number }): SimNode | undefined {
    const world = this.#toWorld(point);
    const slop = 4 / this.#camera.k;
    let best: SimNode | undefined;
    let bestDistance = Infinity;
    for (const node of this.#sim.nodes) {
      const distance = Math.hypot(node.x - world.x, node.y - world.y);
      if (distance <= this.#radius(node) + slop && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  }

  #setHover(node: SimNode | undefined): void {
    if (node === this.#hover) return;
    this.#hover = node;
    if (node) this.#focus = node;
    this.#canvas.style.cursor = node ? "pointer" : "";
    this.wake();
  }

  #down(event: PointerEvent): void {
    if (event.button !== 0 && event.button !== 1) return;
    this.#canvas.setPointerCapture(event.pointerId);
    const point = this.#local(event);
    const node = event.button === 0 && this.#gestures.size === 0 ? this.#nodeAt(point) : undefined;
    this.#gestures.set(event.pointerId, {
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      lastX: point.x,
      lastY: point.y,
      node,
      moved: false,
    });
    if (this.#gestures.size === 2) {
      const [a, b] = [...this.#gestures.values()];
      this.#pinch = { distance: Math.hypot(a!.lastX - b!.lastX, a!.lastY - b!.lastY) };
      this.#release(a!);
    }
    if (node) this.#setHover(node);
  }

  #move(event: PointerEvent): void {
    const point = this.#local(event);
    const gesture = this.#gestures.get(event.pointerId);
    if (!gesture) {
      if (event.pointerType === "mouse") this.#setHover(this.#nodeAt(point));
      return;
    }
    const dx = point.x - gesture.lastX;
    const dy = point.y - gesture.lastY;
    gesture.lastX = point.x;
    gesture.lastY = point.y;
    if (!gesture.moved && Math.hypot(point.x - gesture.startX, point.y - gesture.startY) > CLICK_SLOP) {
      gesture.moved = true;
      this.#steered = true;
      this.#stopFocus();
    }
    if (!gesture.moved) return;

    if (this.#pinch && this.#gestures.size === 2) {
      const [a, b] = [...this.#gestures.values()];
      const distance = Math.hypot(a!.lastX - b!.lastX, a!.lastY - b!.lastY);
      const middle = { x: (a!.lastX + b!.lastX) / 2, y: (a!.lastY + b!.lastY) / 2 };
      this.#zoomAt(middle, distance / Math.max(1, this.#pinch.distance));
      this.#camera.x -= dx / 2 / this.#camera.k;
      this.#camera.y -= dy / 2 / this.#camera.k;
      this.#pinch.distance = distance;
      this.wake();
      return;
    }

    if (gesture.node) {
      const world = this.#toWorld(point);
      gesture.node.fx = world.x;
      gesture.node.fy = world.y;
      this.#sim.alphaTarget = 0.3;
      this.#sim.reheat(0.3);
    } else {
      this.#camera.x -= dx / this.#camera.k;
      this.#camera.y -= dy / this.#camera.k;
    }
    this.wake();
  }

  #up(event: PointerEvent, cancelled = false): void {
    const gesture = this.#gestures.get(event.pointerId);
    if (!gesture) return;
    this.#gestures.delete(event.pointerId);
    if (this.#canvas.hasPointerCapture(event.pointerId)) this.#canvas.releasePointerCapture(event.pointerId);
    this.#release(gesture);
    if (this.#gestures.size < 2) this.#pinch = undefined;

    if (!cancelled && !gesture.moved && this.#gestures.size === 0) {
      const node = gesture.node ?? this.#nodeAt(this.#local(event));
      if (node && !this.#info.get(node.id)?.missing) {
        this.#events.open(node.id, event.button === 1 || event.ctrlKey || event.metaKey);
      }
    }
    if (event.pointerType !== "mouse") this.#setHover(undefined);
    else this.#setHover(this.#nodeAt(this.#local(event)));
  }

  #release(gesture: Gesture): void {
    if (!gesture.node) return;
    gesture.node.fx = undefined;
    gesture.node.fy = undefined;
    this.#sim.alphaTarget = 0;
    this.wake();
  }

  #wheel(event: WheelEvent): void {
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.#height : 1;
    const speed = event.ctrlKey ? 0.01 : 0.0015;
    this.#zoomAt(this.#local(event), Math.exp(-event.deltaY * scale * speed));
    this.wake();
  }

  #zoomAt(point: { x: number; y: number }, factor: number): void {
    this.#steered = true;
    this.#stopFocus();
    const before = this.#toWorld(point);
    this.#camera.k = clamp(this.#camera.k * factor, MIN_ZOOM, MAX_ZOOM);
    const after = this.#toWorld(point);
    this.#camera.x += before.x - after.x;
    this.#camera.y += before.y - after.y;
  }
}

export function labelZoomAlpha(zoom: number, textFade: number, degree: number): number {
  const baseThreshold = 0.9 * Math.pow(2, textFade * 1.5);
  const connectionLead = 1 + Math.log2(Math.max(0, degree) + 1) * CONNECTION_LABEL_LEAD;
  const threshold = baseThreshold / connectionLead;
  return clamp((zoom - threshold * 0.7) / (threshold * 0.5), 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncate(label: string): string {
  return label.length > 40 ? `${label.slice(0, 39)}…` : label;
}
