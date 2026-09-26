/**
 * `markdown` — the unified/remark → React pipeline and the five points over it
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
 * - **Task states come from the registry**, `[ ]` and `[x]` being default
 *   contributions. Shipped interaction (replaceable): left-click toggles non-off → off
 *   and off → on; right-click, or long-press on touch, opens the state menu.
 *
 * The implementation is split so each of those is one file: `schemes.ts` is the
 * allowlist, `regions.ts` finds the body, `processor.ts` builds the pipeline,
 * `render.tsx` walks mdast to React, `tasks.ts` owns marker semantics, and `runtime.ts`
 * holds the single write path. This file is the wiring and the public API.
 */

import { type Kernel, type Unsubscribe } from "@kernel";
import type { ComponentType, ReactNode } from "react";

import {
  POINTS,
  markdownComponentShape,
  markdownDirectiveShape,
  markdownFenceShape,
  markdownRemarkShape,
  markdownTaskStateShape,
  type Command,
  type MarkdownComponent,
  type MarkdownDirective,
  type MarkdownDirectiveProps,
  type MarkdownFence,
  type MarkdownFenceProps,
  type MarkdownRemark,
  type MarkdownTaskState,
} from "../../_shared/points.js";

import { ProcessorCache } from "./processor.js";
import { bodyOf, regionsOf, type DocumentRegions } from "./regions.js";
import { renderTree, type RenderRegistries } from "./render.js";
import { createRuntime } from "./runtime.js";
import { buildTaskRegistry, scanTasks } from "./tasks.js";

export interface MarkdownApi {
  /**
   * Render a document's body to React. `documentId` scopes `doc://` resolution.
   *
   * `offset` is the absolute offset of `text[0]` within the document, and only matters
   * for task checkboxes: it is what a click's text splice is measured from. Omit it and
   * `text` is taken to be this document's **body**, resolved against the document's
   * *current* text at click time — which is what `viewer` does
   * (`render(bodyOf(row.content))`) and is the correct default, because the body's start
   * can move between render and click.
   */
  render(
    text: string,
    options?: { readonly documentId?: string; readonly offset?: number },
  ): ReactNode;
  /** Strip the frontmatter block and the `%%%` sections — what read mode shows. */
  bodyOf(text: string): string;
  /** Offsets of the three regions of one document text (SPEC §3.1). */
  regions(text: string): DocumentRegions;
  /** The task states currently registered, in menu order. */
  taskStates(): readonly MarkdownTaskState[];
  /** Turn an embedded `attachment://` into a wrapper document (SPEC §3.6). */
  promoteToDocument(attachmentId: string, options?: { readonly path?: string }): Promise<string>;
  /**
   * Fires when a `markdown.*` contribution changes, so a caller that cached a
   * `render()` result can re-render. Without it, installing a plugin that adds a
   * directive would leave every open document rendering the old tree until navigation.
   */
  onChange(listener: () => void): Unsubscribe;
}

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
  const directives = kernel.extensions.definePoint<MarkdownDirective>({
    name: POINTS.markdownDirective,
    shape: markdownDirectiveShape,
    key: (directive) => `${directive.kind}:${directive.name}`,
    description: "A `:::name` / `::name` / `:name[…]` directive renderer.",
  });
  const fences = kernel.extensions.definePoint<MarkdownFence>({
    name: POINTS.markdownFence,
    shape: markdownFenceShape,
    key: (fence) => fence.language,
    description: "A renderer for fenced code of one language.",
  });
  const remarkPlugins = kernel.extensions.definePoint<MarkdownRemark>({
    name: POINTS.markdownRemark,
    shape: markdownRemarkShape,
    key: (plugin) => plugin.id,
    description: "A raw unified/remark plugin — the escalated path.",
  });
  const components = kernel.extensions.definePoint<MarkdownComponent>({
    name: POINTS.markdownComponent,
    shape: markdownComponentShape,
    key: (override) => override.node,
    description: "Override the React component for one mdast node type.",
  });
  const taskStates = kernel.extensions.definePoint<MarkdownTaskState>({
    name: POINTS.markdownTaskState,
    shape: markdownTaskStateShape,
    key: (state) => state.marker,
    description: "A task marker: icon, label, menu order, and whether it counts as done.",
  });

  // The two built-in states (SPEC §6.6: "default `taskState` contributions").
  kernel.extensions.contribute<MarkdownTaskState>(POINTS.markdownTaskState, {
    marker: " ",
    label: "To do",
    icon: "☐",
    order: 0,
    done: false,
  });
  kernel.extensions.contribute<MarkdownTaskState>(POINTS.markdownTaskState, {
    marker: "x",
    label: "Done",
    icon: "☑",
    order: 10,
    done: true,
  });

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
  for (const point of [directives, fences, components, taskStates]) {
    point.subscribe(() => {
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
   * attribution comes from `entries()` — the registry records which plugin contributed
   * what, so a thrown render says "plugin X failed" with the right X, which is the whole
   * value of the boundary.
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
          point: POINTS.markdownDirective,
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
          point: POINTS.markdownFence,
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
          point: POINTS.markdownComponent,
          pluginId: entry.pluginId,
        }),
      );
    }

    registries = {
      directives: directiveMap,
      fences: fenceMap,
      overrides: overrideMap,
      tasks: buildTaskRegistry(taskStates.get()),
    };
    registriesRevision = renderRevision;
    return registries;
  };

  const api: MarkdownApi = {
    render: (text, options) => {
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
        return <pre className="overflow-x-auto rounded border border-danger p-3 font-mono">{text}</pre>;
      }

      const taskScan = scanTasks(tree, text, resolved.tasks);
      return renderTree(tree, text, {
        documentId: options?.documentId,
        offset: options?.offset,
        registries: resolved,
        runtime,
        taskScan,
        // The recovery path for a checkbox whose offset drifted: re-parse the text as it
        // is *now* and match by ordinal (`tasks.ts`, `resolveMarkerOffset`).
        rescan: (body) => scanTasks(processor.parse(body), body, resolved.tasks),
      });
    },

    bodyOf,
    regions: regionsOf,

    taskStates: () => currentRegistries().tasks.states,

    promoteToDocument: (attachmentId, options) => runtime.promote(attachmentId, options),

    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  kernel.extensions.contribute<Command>(POINTS.command, {
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
      return runtime.promote(id).then(
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
