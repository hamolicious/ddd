/**
 * `markdown` — the unified/remark → React pipeline and the seven slot ports over it
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
 *   `markdown.remark` — a raw remark plugin can change the meaning of a document.
 * - **Task states come from the `tasks` port**, `[ ]` and `[x]` being this plugin's own
 *   offers on it. Shipped interaction (replaceable): left-click toggles non-off → off
 *   and off → on; right-click, or long-press on touch, opens the state menu.
 *
 * The implementation is split so each of those is one file: `schemes.ts` is the
 * allowlist, `regions.ts` finds the body, `processor.ts` builds the pipeline,
 * `render.tsx` walks mdast to React, `tasks.ts` owns marker semantics, and `runtime.ts`
 * holds the single write path. This file is the wiring and the public API.
 */

import type { Kernel } from "@kernel";
import type { Command } from "@protocols/lm/commands.command";
import type { MarkdownRenderer } from "@protocols/lm/markdown-renderer";
import type { MarkdownAttachment, MarkdownAttachmentProps } from "@protocols/lm/markdown.attachment";
import type { MarkdownCodeBlock, MarkdownCodeBlockProps } from "@protocols/lm/markdown.codeBlock";
import type { MarkdownComponent } from "@protocols/lm/markdown.component";
import type { MarkdownDirective, MarkdownDirectiveProps } from "@protocols/lm/markdown.directive";
import type { MarkdownFence, MarkdownFenceProps } from "@protocols/lm/markdown.fence";
import type { MarkdownRemark } from "@protocols/lm/markdown.remark";
import type { MarkdownTaskState } from "@protocols/lm/markdown.taskState";
import type { SettingsSection } from "@protocols/lm/settings.section";
import type { ComponentType, ReactNode } from "react";

import { type EmbedChain } from "./doc-embed.js";
import { clampEmbedDepth, DEFAULT_EMBED_DEPTH, EMBED_DEPTH_KEY, MarkdownSettings } from "./MarkdownSettings.js";
import { DocLink } from "./links.js";
import { ProcessorCache } from "./processor.js";
import { bodyOf, regionsOf } from "../../_shared/regions.js";
import { renderTree, type RenderRegistries } from "./render.js";
import { createRuntime } from "./runtime.js";
import { buildTaskRegistry, scanTasks } from "./tasks.js";

/**
 * What this plugin serves on its `renderer` port: `lm/markdown-renderer`. The members are
 * documented in the protocol package; two notes that belong with the implementation:
 *
 * - `render`'s `offset` is the absolute offset of `text[0]` within the document, and only
 *   matters for task checkboxes: it is what a click's text splice is measured from. Omit
 *   it and `text` is taken to be this document's **body**, resolved against the document's
 *   *current* text at click time — which is what `viewer` does (`render(bodyOf(row.content))`)
 *   and is the correct default, because the body's start can move between render and click.
 * - `onChange` fires when a `markdown.*` offer changes, so a caller that cached a `render()`
 *   result can re-render. Without it, installing a plugin that adds a directive would leave
 *   every open document rendering the old tree until navigation.
 */
export type MarkdownApi = MarkdownRenderer;

/**
 * The live runtime, for {@link deactivate}.
 *
 * INTEGRATION (kernel-runtime): `DeactivateFn` takes no arguments, so module state is the
 * only way for teardown to reach what `activate` built. That is fine for a single client
 * per realm and wrong the moment two kernels share one (a harness mounting two
 * workspaces). Either `deactivate(kernel)` or letting `activate` return a disposer
 * alongside its API would remove the need for this variable.
 */
let liveRuntime: { dispose(): void } | undefined;

export default function activate(kernel: Kernel): MarkdownApi {
  // The seven hosts. Shapes and duplicate keys come from the protocol packages; every
  // list is in seat order, which is the order the wiring editor shows.
  const directives = kernel.ports.collect<MarkdownDirective>("directives");
  const fences = kernel.ports.collect<MarkdownFence>("fences");
  const codeBlocks = kernel.ports.collect<MarkdownCodeBlock>("code");
  const remarkPlugins = kernel.ports.collect<MarkdownRemark>("remark");
  const components = kernel.ports.collect<MarkdownComponent>("components");
  const taskStates = kernel.ports.collect<MarkdownTaskState>("tasks");
  const attachmentRenderers = kernel.ports.collect<MarkdownAttachment>("attachments");

  // The two built-in states (SPEC §6.6: "default `taskState` contributions"), offered on
  // this plugin's own `task-states` port and seated first by its `order` hint.
  kernel.ports.offer<MarkdownTaskState>("task-states", [
    { marker: " ", label: "To do", icon: "☐", order: 0, done: false },
    { marker: "x", label: "Done", icon: "☑", order: 10, done: true },
  ]);

  const runtime = createRuntime(kernel);
  liveRuntime = runtime;

  // -------------------------------------------------------------------------
  // Revisions: the processor and the render registries are rebuilt only when their
  // inputs actually move (`web/CONTRACTS.md`: "build the processor once per point
  // revision, not per render").
  //
  // Two counters, not one, because they invalidate different things: a new
  // `markdown.remark` contribution changes how text *parses* and must rebuild the
  // unified processor, while a new directive or task state only changes how the tree
  // *renders* and must not.
  // -------------------------------------------------------------------------
  let parseRevision = 0;
  let renderRevision = 0;
  const listeners = new Set<() => void>();
  const announce = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        kernel.log.error("markdown.onChange listener threw", error);
      }
    }
  };

  remarkPlugins.subscribe(() => {
    parseRevision += 1;
    renderRevision += 1;
    announce();
  });
  for (const host of [directives, fences, codeBlocks, components, taskStates, attachmentRenderers]) {
    host.subscribe(() => {
      renderRevision += 1;
      announce();
    });
  }

  const processors = new ProcessorCache();
  let registries: RenderRegistries | undefined;
  let registriesRevision = -1;

  /**
   * Resolve the registries, wrapping every contributed component in the kernel's error
   * boundary (SPEC §6.4: "every contribution is wrapped in an error boundary"). The
   * attribution comes from `entries()` — the host records which plugin offered what, so a
   * thrown render says "plugin X failed" with the right X, which is the whole value of
   * the boundary.
   */
  const currentRegistries = (): RenderRegistries => {
    if (registries && registriesRevision === renderRevision) return registries;

    const directiveMap = new Map<string, ComponentType<MarkdownDirectiveProps>>();
    for (const entry of directives.entries()) {
      const key = `${entry.value.kind}:${entry.value.name}`;
      if (directiveMap.has(key)) continue;
      directiveMap.set(
        key,
        kernel.ui.boundary(entry.value.component, {
          point: "markdown.directive",
          pluginId: entry.pluginId,
        }),
      );
    }

    const fenceMap = new Map<string, ComponentType<MarkdownFenceProps>>();
    for (const entry of fences.entries()) {
      if (fenceMap.has(entry.value.language)) continue;
      fenceMap.set(
        entry.value.language,
        kernel.ui.boundary(entry.value.component, {
          point: "markdown.fence",
          pluginId: entry.pluginId,
        }),
      );
    }

    const overrideMap = new Map<string, ComponentType<Record<string, unknown>>>();
    for (const entry of components.entries()) {
      if (overrideMap.has(entry.value.node)) continue;
      overrideMap.set(
        entry.value.node,
        kernel.ui.boundary(entry.value.component, {
          point: "markdown.component",
          pluginId: entry.pluginId,
        }),
      );
    }

    // The first seat wins (PLUGIN-PROTOCOLS §6a): the wiring decides, not an `order`.
    const winner = attachmentRenderers.entries()[0];
    const attachment: ComponentType<MarkdownAttachmentProps> | undefined = winner
      ? kernel.ui.boundary(winner.value.component, {
          point: "markdown.attachment",
          pluginId: winner.pluginId,
        })
      : undefined;

    const codeWinner = codeBlocks.entries()[0];
    const codeBlock: ComponentType<MarkdownCodeBlockProps> | undefined = codeWinner
      ? kernel.ui.boundary(codeWinner.value.component, {
          point: "markdown.codeBlock",
          pluginId: codeWinner.pluginId,
        })
      : undefined;

    registries = {
      directives: directiveMap,
      fences: fenceMap,
      codeBlock,
      overrides: overrideMap,
      tasks: buildTaskRegistry(taskStates.get()),
      attachment,
    };
    registriesRevision = renderRevision;
    return registries;
  };

  // -------------------------------------------------------------------------
  // Embedded documents (`![](doc://…)`): how many levels deep, per user.
  // -------------------------------------------------------------------------
  try {
    kernel.settings.defineSchema({
      [EMBED_DEPTH_KEY]: {
        type: "number",
        label: "Embedded documents, levels deep",
        description: "How far a document embedded in a document embedded in … is shown. 0 shows links.",
        default: DEFAULT_EMBED_DEPTH,
      },
    });
    kernel.settings.subscribe(() => {
      renderRevision += 1;
      announce();
    });
  } catch (error) {
    kernel.log.warn("the embed depth setting is unavailable; using the default", error);
  }
  const embedDepth = (): number => {
    try {
      return clampEmbedDepth(kernel.settings.get(EMBED_DEPTH_KEY));
    } catch {
      return DEFAULT_EMBED_DEPTH;
    }
  };

  kernel.ports.offer<SettingsSection>("settings", {
    id: "markdown",
    title: "Markdown",
    order: 45,
    description: "How documents embedded with ![](doc://…) are shown.",
    component: () => <MarkdownSettings kernel={kernel} />,
  });

  const renderWith = (
    text: string,
    documentId: string | undefined,
    offset: number | undefined,
    chain: EmbedChain,
    maxDepth: number,
  ): ReactNode => {
      const resolved = currentRegistries();
      const processor = processors.get(parseRevision, () => remarkPlugins.get());

      let tree;
      try {
        tree = processor.parse(text);
      } catch (error) {
        // A throw here is a contributed `markdown.remark` plugin, not markdown: remark's
        // own parser is total. Showing the text beats showing nothing, and the error names
        // the pipeline so the aggregated notice has something to point at.
        kernel.log.error("markdown pipeline threw while parsing", error);
        return <pre className="markdown:overflow-x-auto markdown:rounded markdown:border markdown:border-danger markdown:p-3 markdown:font-mono">{text}</pre>;
      }

      const taskScan = scanTasks(tree, text, resolved.tasks);
      return renderTree(tree, text, {
        documentId,
        offset,
        registries: resolved,
        runtime,
        taskScan,
        // The recovery path for a checkbox whose offset drifted: re-parse the text as it
        // is *now* and match by ordinal (`tasks.ts`, `resolveMarkerOffset`).
        rescan: (body) => scanTasks(processor.parse(body), body, resolved.tasks),
        embeds: {
          chain,
          maxDepth,
          // The embedded document's own body, with its own id: its checkboxes write there.
          renderBody: (row, next) => renderWith(bodyOf(row.content ?? ""), row.id, undefined, next, maxDepth),
        },
      });
  };

  const api: MarkdownApi = {
    render: (text, options) =>
      renderWith(
        text,
        options?.documentId,
        options?.offset,
        { depth: 0, ancestors: options?.documentId ? [options.documentId] : [] },
        embedDepth(),
      ),

    bodyOf,
    regions: regionsOf,

    taskStates: () => currentRegistries().tasks.states,

    renderDocLink: (documentId) => <DocLink id={documentId} runtime={runtime} />,

    renderAttachment: (attachmentId, options) => {
      const Renderer = currentRegistries().attachment;
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
    },

    promoteToDocument: (attachmentId) => runtime.promote(attachmentId),

    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  kernel.ports.offer<Command>("commands", {
    id: "markdown.promoteToDocument",
    title: "Promote attachment to document",
    category: "Markdown",
    // Enabled only when there is something to act on, so the palette does not offer a
    // command that can only fail (`Command.when` is what the palette filters on).
    when: () => runtime.focusedAttachment() !== null,
    run: (argument) => {
      // From the attachment's own menu the id is the argument; from the palette it is the
      // embedded attachment the user last touched.
      const id = typeof argument === "string" && argument.length > 0 ? argument : runtime.focusedAttachment();
      if (id === null) {
        kernel.ui.notify({
          id: "markdown.promote.no-target",
          level: "info",
          message: "Select an embedded file first.",
        });
        return;
      }
      // Creating the wrapper document is a REST call (SPEC §3.6, §5.1), so it rejects
      // offline. The palette closes on `run`, so without a notice here the command looked
      // like it had done nothing at all — the attachment's own menu already says so.
      // From the palette, the site is the one the focused attachment was touched at, and
      // only when the id is that attachment's.
      const site = id === runtime.focusedAttachment() ? runtime.focusedSite() : undefined;
      return runtime.promoteEmbed(id, site).then(
        (documentId) => {
          runtime.focusAttachment(null);
          runtime.openDocument(documentId);
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
  });

  kernel.ports.serve("renderer", api);
  return api;
}

/**
 * Reload-only activation means this runs on teardown alone (`?safe=bare`, tests).
 * Its one job is the object URLs `runtime.ts` deliberately keeps for the life of the
 * page — see the cache note there for why they are not revoked per component.
 */
export function deactivate(): void {
  liveRuntime?.dispose();
  liveRuntime = undefined;
}
