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

export type MarkdownApi = MarkdownRenderer;

export const addAttachmentRenderer: (items: MarkdownAttachment | readonly MarkdownAttachment[]) => () => void =
  attachmentRegistry.add;

export const addCodeBlockRenderer: (items: MarkdownCodeBlock | readonly MarkdownCodeBlock[]) => () => void =
  codeBlockRegistry.add;

export const addComponent: (items: MarkdownComponent | readonly MarkdownComponent[]) => () => void =
  componentRegistry.add;

export const addDirective: (items: MarkdownDirective | readonly MarkdownDirective[]) => () => void =
  directiveRegistry.add;

export const addFence: (items: MarkdownFence | readonly MarkdownFence[]) => () => void = fenceRegistry.add;

export const addRemarkPlugin: (items: MarkdownRemark | readonly MarkdownRemark[]) => () => void = remarkRegistry.add;

export const addTaskState: (items: MarkdownTaskState | readonly MarkdownTaskState[]) => () => void =
  taskStateRegistry.add;

let kernelRef: Kernel | undefined;
let runtime: (MarkdownRuntime & { dispose(): void }) | undefined;
let teardown: (() => void)[] = [];

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
    rescan: (body) => scanTasks(processor.parse(body), body, resolved.tasks),
    embeds: {
      chain,
      maxDepth,
      renderBody: (row, next) =>
        renderWith(kernel, run, bodyOfText(row.content ?? ""), row.id, undefined, next, maxDepth),
    },
  });
}

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

export const bodyOf: (text: string) => string = bodyOfText;

export const regions: MarkdownRenderer["regions"] = regionsOf;

export function taskStates(): readonly MarkdownTaskState[] {
  return buildTaskRegistry(taskStateRegistry.get()).states;
}

export function renderDocLink(documentId: string): ReactNode {
  return <DocLink id={documentId} runtime={live().runtime} />;
}

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

export function promoteToDocument(attachmentId: string): Promise<string> {
  return live().runtime.promote(attachmentId);
}

export function onChange(listener: () => void): Unsubscribe {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

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
      when: () => run.focusedAttachment() !== null,
      run: (argument) => {
        const id = typeof argument === "string" && argument.length > 0 ? argument : run.focusedAttachment();
        if (id === null) {
          kernel.ui.notify({
            id: "markdown.promote.no-target",
            level: "info",
            message: "Select an embedded file first.",
          });
          return;
        }
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

export function deactivate(): void {
  for (const off of teardown.splice(0)) {
    try {
      off();
    } catch {
    }
  }
  runtime?.dispose();
  runtime = undefined;
  kernelRef = undefined;
  registries = undefined;
  registriesRevision = -1;
}
