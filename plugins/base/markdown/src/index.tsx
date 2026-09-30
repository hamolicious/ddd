/**
 * `markdown` — the unified/remark → React pipeline, and the seven registries over it
 * (SPEC §6.6).
 *
 * What this plugin is responsible for, in the order of how easily each one goes wrong:
 *
 * - **No raw HTML in v1** (SPEC §8). The pipeline never passes HTML through, and link
 *   and image schemes are allowlisted: `http`, `https`, `mailto`, `attachment`, `doc`.
 *   Anything else renders as text. This is the plugin's security boundary.
 * - **`doc://<ulid>`** renders the target document's *title* (from the projection, so
 *   it works offline) and navigates in-app. A missing target renders as a broken-link
 *   chip, never as a dead URL.
 * - **`attachment://<ulid>`** renders images inline and everything else as a chip, and
 *   a file that is not cached offline renders "not available offline" (SPEC §3.6).
 * - **Directives and fences are the blessed syntaxes**: they degrade to literal text
 *   when the contributing plugin is absent, which is why they are preferred over
 *   `addRemarkPlugin` — a raw remark plugin can change the meaning of a document.
 * - **Task states come from `addTaskState`**, `[ ]` and `[x]` being this plugin's own.
 *   Shipped interaction (replaceable): left-click toggles non-off → off and off → on;
 *   right-click, or long-press on touch, opens the state menu.
 *
 * The implementation is split so each of those is one file: `schemes.ts` is the
 * allowlist, `regions.ts` finds the body, `processor.ts` builds the pipeline,
 * `render.tsx` walks mdast to React, `tasks.ts` owns marker semantics, `runtime.ts`
 * holds the single write path, and `api.ts` the types and registries. This file is the
 * public API.
 */

import type { Kernel, Unsubscribe } from "@kernel";
import type { ComponentType, ReactNode } from "react";

import { addCommand } from "plugin:commands";
import { addSection } from "plugin:settings";

import {
  attachmentRegistry,
  codeBlockRegistry,
  componentRegistry,
  directiveRegistry,
  fenceRegistry,
  remarkRegistry,
  taskStateRegistry,
  type MarkdownAttachment,
  type MarkdownAttachmentProps,
  type MarkdownCodeBlock,
  type MarkdownCodeBlockProps,
  type MarkdownComponent,
  type MarkdownDirective,
  type MarkdownDirectiveProps,
  type MarkdownFence,
  type MarkdownFenceProps,
  type MarkdownRemark,
  type MarkdownRenderer,
  type MarkdownTaskState,
  type RenderAttachmentOptions,
  type RenderOptions,
} from "./api.js";
import { type EmbedChain } from "./doc-embed.js";
import { clampEmbedDepth, DEFAULT_EMBED_DEPTH, EMBED_DEPTH_KEY, MarkdownSettings } from "./MarkdownSettings.js";
import { DocLink } from "./links.js";
import { MENU_ACTIONS } from "./menu.js";
import { ProcessorCache } from "./processor.js";
import { bodyOf as bodyOfText, regionsOf } from "../../_shared/regions.js";
import { renderTree, type RenderRegistries } from "./render.js";
import { createRuntime, type MarkdownRuntime } from "./runtime.js";
import { buildTaskRegistry, scanTasks } from "./tasks.js";

export type {
  DocumentRegions,
  MarkdownAttachment,
  MarkdownAttachmentProps,
  MarkdownCodeBlock,
  MarkdownCodeBlockProps,
  MarkdownComponent,
  MarkdownDirective,
  MarkdownDirectiveProps,
  MarkdownFence,
  MarkdownFenceProps,
  MarkdownRemark,
  MarkdownRenderer,
  MarkdownTaskState,
  RenderAttachmentOptions,
  RenderOptions,
  TextSpan,
} from "./api.js";
export { TASK_SPLICE_ORIGIN } from "./runtime.js";

/** The renderer functions as one type; the same as `MarkdownRenderer`. */
export type MarkdownApi = MarkdownRenderer;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Draw embedded files (`![](attachment://…)`) yourself. The first in `order` wins; with
 * none, markdown draws an inline image or a chip. Returns the function that takes it out.
 */
export const addAttachmentRenderer: (items: MarkdownAttachment | readonly MarkdownAttachment[]) => () => void =
  attachmentRegistry.add;

/**
 * Draw fenced code blocks no fence claims (```ts, ```rust, no language). The first in
 * `order` wins; with none, markdown draws a `<pre>`. Returns the function that takes it out.
 */
export const addCodeBlockRenderer: (items: MarkdownCodeBlock | readonly MarkdownCodeBlock[]) => () => void =
  codeBlockRegistry.add;

/** Replace the component for one mdast node type. Returns the function that takes it out. */
export const addComponent: (items: MarkdownComponent | readonly MarkdownComponent[]) => () => void =
  componentRegistry.add;

/**
 * Render a directive (`:::name`, `::name`, `:name[…]`). Without it, the directive shows
 * as the text it was written as. Returns the function that takes it out.
 */
export const addDirective: (items: MarkdownDirective | readonly MarkdownDirective[]) => () => void =
  directiveRegistry.add;

/** Render fenced code blocks of one language (```mermaid). Returns the function that takes it out. */
export const addFence: (items: MarkdownFence | readonly MarkdownFence[]) => () => void = fenceRegistry.add;

/**
 * Add a raw remark plugin to the parser: the last resort, since it can change what any
 * document means. Plugins run in `order`. Returns the function that takes it out.
 */
export const addRemarkPlugin: (items: MarkdownRemark | readonly MarkdownRemark[]) => () => void = remarkRegistry.add;

/**
 * Add a task marker (`[/]`, `[-]`, …). States are listed in `order`; markdown's own
 * `[ ]` and `[x]` are 0 and 10. Returns the function that takes it out.
 */
export const addTaskState: (items: MarkdownTaskState | readonly MarkdownTaskState[]) => () => void =
  taskStateRegistry.add;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let kernelRef: Kernel | undefined;
let runtime: (MarkdownRuntime & { dispose(): void }) | undefined;
/** What `activate` set up and `deactivate` takes down. */
let teardown: (() => void)[] = [];

// Revisions: the processor and the render registries are rebuilt only when their inputs
// actually move (`web/CONTRACTS.md`: "build the processor once per point revision, not
// per render"). Two counters, because a new remark plugin changes how text *parses* and
// must rebuild the unified processor, while a new directive or task state only changes
// how the tree *renders* and must not.
let parseRevision = 0;
let renderRevision = 0;
const listeners = new Set<() => void>();
const processors = new ProcessorCache();
let registries: RenderRegistries | undefined;
let registriesRevision = -1;

const announce = (): void => {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      kernelRef?.log.error("markdown.onChange listener threw", error);
    }
  }
};

const rendered = (): void => {
  renderRevision += 1;
  announce();
};

function live(): { readonly kernel: Kernel; readonly runtime: MarkdownRuntime } {
  if (!kernelRef || !runtime) throw new Error("markdown: the plugin is not active yet; call this from your own activate or later");
  return { kernel: kernelRef, runtime };
}

/**
 * The registries, every contributed component wrapped in the kernel's error boundary
 * (SPEC §6.4) under the plugin that added it, so a thrown render says which plugin failed.
 */
function currentRegistries(kernel: Kernel): RenderRegistries {
  if (registries && registriesRevision === renderRevision) return registries;
  const wrap = <P extends object>(component: ComponentType<P>, point: string, pluginId: string): ComponentType<P> =>
    kernel.ui.boundary(component, { point: `markdown.${point}`, pluginId });

  const directiveMap = new Map<string, ComponentType<MarkdownDirectiveProps>>();
  for (const entry of directiveRegistry.entries()) {
    directiveMap.set(`${entry.value.kind}:${entry.value.name}`, wrap(entry.value.component, "directive", entry.pluginId));
  }
  const fenceMap = new Map<string, ComponentType<MarkdownFenceProps>>();
  for (const entry of fenceRegistry.entries()) {
    fenceMap.set(entry.value.language, wrap(entry.value.component, "fence", entry.pluginId));
  }
  const overrideMap = new Map<string, ComponentType<Record<string, unknown>>>();
  for (const entry of componentRegistry.entries()) {
    overrideMap.set(entry.value.node, wrap(entry.value.component, "component", entry.pluginId));
  }

  // The first in order wins.
  const winner = attachmentRegistry.entries()[0];
  const attachment: ComponentType<MarkdownAttachmentProps> | undefined = winner
    ? wrap(winner.value.component, "attachment", winner.pluginId)
    : undefined;
  const codeWinner = codeBlockRegistry.entries()[0];
  const codeBlock: ComponentType<MarkdownCodeBlockProps> | undefined = codeWinner
    ? wrap(codeWinner.value.component, "codeBlock", codeWinner.pluginId)
    : undefined;

  registries = {
    directives: directiveMap,
    fences: fenceMap,
    codeBlock,
    overrides: overrideMap,
    tasks: buildTaskRegistry(taskStateRegistry.get()),
    attachment,
  };
  registriesRevision = renderRevision;
  return registries;
}

/** Embedded documents (`![](doc://…)`): how many levels deep, per user. */
function embedDepth(kernel: Kernel): number {
  try {
    return clampEmbedDepth(kernel.settings.get(EMBED_DEPTH_KEY));
  } catch {
    return DEFAULT_EMBED_DEPTH;
  }
}

function renderWith(
  kernel: Kernel,
  run: MarkdownRuntime,
  text: string,
  documentId: string | undefined,
  offset: number | undefined,
  chain: EmbedChain,
  maxDepth: number,
): ReactNode {
  const resolved = currentRegistries(kernel);
  const processor = processors.get(parseRevision, () => remarkRegistry.get());

  let tree;
  try {
    tree = processor.parse(text);
  } catch (error) {
    // A throw here is an added remark plugin, not markdown: remark's own parser is total.
    // Showing the text beats showing nothing.
    kernel.log.error("markdown pipeline threw while parsing", error);
    return <pre className="markdown:overflow-x-auto markdown:rounded markdown:border markdown:border-danger markdown:p-3 markdown:font-mono">{text}</pre>;
  }

  const taskScan = scanTasks(tree, text, resolved.tasks);
  return renderTree(tree, text, {
    documentId,
    offset,
    registries: resolved,
    runtime: run,
    taskScan,
    // The recovery path for a checkbox whose offset drifted: re-parse the text as it is
    // *now* and match by ordinal (`tasks.ts`, `resolveMarkerOffset`).
    rescan: (body) => scanTasks(processor.parse(body), body, resolved.tasks),
    embeds: {
      chain,
      maxDepth,
      // The embedded document's own body, with its own id: its checkboxes write there.
      renderBody: (row, next) =>
        renderWith(kernel, run, bodyOfText(row.content ?? ""), row.id, undefined, next, maxDepth),
    },
  });
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

/**
 * Render a body to React.
 *
 * `options.offset` is the absolute offset of `text[0]` within the document, and only
 * matters for task checkboxes: it is what a click's text splice is measured from. Omit it
 * and `text` is taken to be this document's **body**, resolved against the document's
 * *current* text at click time — what `viewer` does (`render(bodyOf(row.content))`).
 */
export function render(text: string, options?: RenderOptions): ReactNode {
  const { kernel, runtime: run } = live();
  return renderWith(
    kernel,
    run,
    text,
    options?.documentId,
    options?.offset,
    { depth: 0, ancestors: options?.documentId ? [options.documentId] : [] },
    embedDepth(kernel),
  );
}

/** Strip the frontmatter and the `%%%` sections: what read mode shows. */
export const bodyOf: (text: string) => string = bodyOfText;

/** Where the frontmatter, the body and the `%%%` sections are in a document's text. */
export const regions: MarkdownRenderer["regions"] = regionsOf;

/** The task states added, in menu order. */
export function taskStates(): readonly MarkdownTaskState[] {
  return buildTaskRegistry(taskStateRegistry.get()).states;
}

/** A link to a document as the body draws `[](doc://…)`: its live title, colour and icon. */
export function renderDocLink(documentId: string): ReactNode {
  return <DocLink id={documentId} runtime={live().runtime} />;
}

/** An attachment as the winning renderer draws it, or `undefined` when none is added. */
export function renderAttachment(attachmentId: string, options: RenderAttachmentOptions): ReactNode | undefined {
  const Renderer = currentRegistries(live().kernel).attachment;
  if (!Renderer) return undefined;
  return (
    <Renderer
      id={attachmentId}
      alt={options.alt}
      placement={options.placement}
      fallback={options.fallback}
      frame={(content) => content}
    />
  );
}

/** Turn an embedded `attachment://` into a wrapper document, filed where "Files go to" says. */
export function promoteToDocument(attachmentId: string): Promise<string> {
  return live().runtime.promote(attachmentId);
}

/**
 * Called when anything added to markdown changes, so a cached render can re-render.
 * Without it, enabling a plugin that adds a directive would leave every open document
 * rendering the old tree until navigation.
 */
export function onChange(listener: () => void): Unsubscribe {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

type RouterModule = typeof import("plugin:router");
type FoldersModule = typeof import("plugin:folders");
type ContextMenuModule = typeof import("plugin:context-menu");
type SurfaceModule = typeof import("plugin:document-surface");

export default async function activate(kernel: Kernel): Promise<void> {
  const optional = <M,>(id: string): Promise<M | undefined> =>
    kernel.plugins.optional<M>(id).catch((cause: unknown) => {
      kernel.log.warn(`markdown: "${id}" could not be loaded; going on without it`, cause);
      return undefined;
    });
  const [router, folders, menu, surface] = await Promise.all([
    optional<RouterModule>("router"),
    optional<FoldersModule>("folders"),
    optional<ContextMenuModule>("context-menu"),
    optional<SurfaceModule>("document-surface"),
  ]);

  kernelRef = kernel;
  // Views that claim a document (`prefer`) draw its embeds: a saved search embeds as results.
  runtime = createRuntime(kernel, {
    router,
    folders,
    menu,
    modes: surface ? () => surface.modeEntries() : undefined,
  });

  const offs: (() => void)[] = [];
  offs.push(
    remarkRegistry.subscribe(() => {
      parseRevision += 1;
      rendered();
    }),
  );
  for (const registry of [
    directiveRegistry,
    fenceRegistry,
    codeBlockRegistry,
    componentRegistry,
    taskStateRegistry,
    attachmentRegistry,
  ] as const) {
    offs.push((registry.subscribe as (listener: () => void) => Unsubscribe)(rendered));
  }
  if (surface) offs.push(surface.onModesChange(rendered));

  // The two built-in states (SPEC §6.6), first in the menu.
  offs.push(
    addTaskState([
      { marker: " ", label: "To do", icon: "☐", order: 0, done: false },
      { marker: "x", label: "Done", icon: "☑", order: 10, done: true },
    ]),
  );

  try {
    kernel.settings.defineSchema({
      [EMBED_DEPTH_KEY]: {
        type: "number",
        label: "Embedded documents, levels deep",
        description: "How far a document embedded in a document embedded in … is shown. 0 shows links.",
        default: DEFAULT_EMBED_DEPTH,
      },
    });
    offs.push(kernel.settings.subscribe(rendered));
  } catch (error) {
    kernel.log.warn("the embed depth setting is unavailable; using the default", error);
  }

  // A task's states and a file's actions, in `context-menu`'s menus (`menu.ts`).
  if (menu) offs.push(menu.addAction(MENU_ACTIONS));

  offs.push(
    addSection({
      id: "markdown",
      title: "Markdown",
      order: 45,
      description: "How documents embedded with ![](doc://…) are shown.",
      component: () => <MarkdownSettings kernel={kernel} />,
    }),
  );

  const run = runtime;
  offs.push(
    addCommand({
      id: "markdown.promoteToDocument",
      title: "Promote attachment to document",
      category: "Markdown",
      // Enabled only when there is something to act on, so the palette does not offer a
      // command that can only fail.
      when: () => run.focusedAttachment() !== null,
      run: (argument) => {
        // From the attachment's own menu the id is the argument; from the palette it is the
        // embedded attachment the user last touched.
        const id = typeof argument === "string" && argument.length > 0 ? argument : run.focusedAttachment();
        if (id === null) {
          kernel.ui.notify({
            id: "markdown.promote.no-target",
            level: "info",
            message: "Select an embedded file first.",
          });
          return;
        }
        // Creating the wrapper document is a REST call (SPEC §3.6, §5.1), so it rejects
        // offline; the palette closes on `run`, so the failure needs a notice. From the
        // palette, the site is the one the focused attachment was touched at.
        const site = id === run.focusedAttachment() ? run.focusedSite() : undefined;
        return run.promoteEmbed(id, site).then(
          (documentId) => {
            run.focusAttachment(null);
            run.openDocument(documentId);
          },
          (error: unknown) => {
            kernel.log.error("promote to document failed", { id, error });
            kernel.ui.notify({
              id: `markdown.promote.${id}`,
              level: "error",
              message: "Could not create a document for that file.",
              detail: `${error instanceof Error ? error.message : String(error)}\n\nCreating a document needs the server; the file itself is untouched.`,
            });
          },
        );
      },
    }),
  );

  teardown = offs;
}

/**
 * Teardown (`?safe=bare`, tests): takes out what `activate` added, and releases the object
 * URLs `runtime.ts` deliberately keeps for the life of the page.
 */
export function deactivate(): void {
  for (const off of teardown.splice(0)) {
    try {
      off();
    } catch {
      // Teardown is best effort.
    }
  }
  runtime?.dispose();
  runtime = undefined;
  kernelRef = undefined;
  registries = undefined;
  registriesRevision = -1;
}
