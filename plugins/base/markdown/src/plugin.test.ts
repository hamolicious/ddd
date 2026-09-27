/**
 * `activate()` against a fake kernel: the wiring, not the pipeline.
 *
 * The pipeline suites call `renderTree` directly, which is the right level for "does this
 * markdown become that tree". What they cannot show is the half SPEC §6.6 is actually
 * about — that the **registry** drives the parser. A marker becomes a checkbox because a
 * `markdown.taskState` contribution arrived, and the only way to prove that end to end is
 * to contribute one the way another plugin would and re-render.
 *
 * The fake kernel below implements exactly the registry semantics
 * `kernel/src/runtime/registry.test.ts` pins — buffering, first-key-wins, live
 * subscriptions, `entries()` with attribution — and nothing else. It is ~80 lines because
 * that is genuinely all of `@kernel` this plugin touches.
 */

import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";

import type { Contribution, Kernel } from "@kernel";

import { POINTS, type Command, type MarkdownTaskState } from "../../_shared/points.js";

import activate, { type MarkdownApi } from "./index.js";

// ---------------------------------------------------------------------------
// the fake kernel
// ---------------------------------------------------------------------------

interface FakeKernel {
  readonly kernel: Kernel;
  /** Contribute as some other plugin would. */
  contribute<T>(point: string, value: T, pluginId?: string, order?: number): void;
  values<T>(point: string): readonly T[];
  readonly defined: string[];
  readonly created: string[];
  readonly notices: string[];
}

function fakeKernel(attachmentName = "Scan 1.pdf"): FakeKernel {
  const entries = new Map<string, Contribution<unknown>[]>();
  const listeners = new Map<string, Set<(values: readonly unknown[]) => void>>();
  const keys = new Map<string, (value: unknown) => string>();
  const defined: string[] = [];
  const created: string[] = [];
  const notices: string[] = [];

  const ordered = (point: string): Contribution<unknown>[] =>
    [...(entries.get(point) ?? [])].sort((a, b) => a.order - b.order);
  const values = (point: string): readonly unknown[] => ordered(point).map((entry) => entry.value);
  const announce = (point: string): void => {
    for (const listener of listeners.get(point) ?? []) listener(values(point));
  };

  const add = (point: string, value: unknown, pluginId: string, order: number): void => {
    const key = keys.get(point);
    if (key) {
      // First registration wins, as the real registry does.
      const identity = key(value);
      if (ordered(point).some((entry) => key(entry.value) === identity)) return;
    }
    const list = entries.get(point) ?? [];
    list.push({ point, pluginId, value, order });
    entries.set(point, list);
    announce(point);
  };

  const kernel = {
    pluginId: "markdown",
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    extensions: {
      definePoint: <T,>(definition: { name: string; key?: (value: T) => string }) => {
        defined.push(definition.name);
        if (definition.key) keys.set(definition.name, definition.key as (value: unknown) => string);
        return {
          name: definition.name,
          get: () => values(definition.name) as readonly T[],
          entries: () => ordered(definition.name) as readonly Contribution<T>[],
          subscribe: (listener: (next: readonly T[]) => void) => {
            const set = listeners.get(definition.name) ?? new Set();
            set.add(listener as (next: readonly unknown[]) => void);
            listeners.set(definition.name, set);
            listener(values(definition.name) as readonly T[]);
            return () => set.delete(listener as (next: readonly unknown[]) => void);
          },
        };
      },
      contribute: <T,>(point: string, value: T, options?: { order?: number }) => {
        add(point, value, "markdown", options?.order ?? 100);
        return { dispose: () => {} };
      },
      get: (point: string) => values(point),
    },
    services: { get: () => undefined },
    ui: {
      // The real one wraps in an error boundary; identity keeps the tree readable here.
      boundary: <P,>(component: P) => component,
      notify: (notice: { message: string }) => {
        notices.push(notice.message);
        return () => {};
      },
    },
    documents: {
      create: ({ text }: { text: string }) => {
        created.push(text);
        return Promise.resolve("01JNEWDOCUMENT0000000000000");
      },
    },
    session: {
      fetch: () =>
        Promise.resolve({
          json: () => Promise.resolve({ name: attachmentName, mime: "application/pdf", size: 1024 }),
        }),
    },
  } as unknown as Kernel;

  return {
    kernel,
    contribute: (point, value, pluginId = "some-plugin", order = 100) => add(point, value, pluginId, order),
    values: <T,>(point: string) => values(point) as readonly T[],
    defined,
    created,
    notices,
  };
}

/** `true` when the rendered tree contains a component with this name. */
function hasComponent(node: ReactNode, name: string): boolean {
  if (Array.isArray(node)) return node.some((child) => hasComponent(child as ReactNode, name));
  if (!isValidElement(node)) return false;
  if (typeof node.type === "function" && node.type.name === name) return true;
  return hasComponent((node.props as { children?: ReactNode }).children, name);
}

// ---------------------------------------------------------------------------

describe("activate", () => {
  it("defines the seven markdown.* points", () => {
    const host = fakeKernel();
    activate(host.kernel);
    expect(host.defined).toEqual([
      POINTS.markdownDirective,
      POINTS.markdownFence,
      POINTS.markdownCodeBlock,
      POINTS.markdownRemark,
      POINTS.markdownComponent,
      POINTS.markdownTaskState,
      POINTS.markdownAttachment,
    ]);
  });

  it("ships [ ] and [x] as default taskState contributions (SPEC §6.6)", () => {
    const host = fakeKernel();
    const api = activate(host.kernel);
    expect(api.taskStates().map((state) => state.marker)).toEqual([" ", "x"]);
    expect(api.taskStates().map((state) => state.done)).toEqual([false, true]);
  });

  it("registers the promote-to-document command, disabled until something is focused", () => {
    const host = fakeKernel();
    activate(host.kernel);
    const command = host.values<Command>(POINTS.command).find((c) => c.id === "markdown.promoteToDocument");
    expect(command).toBeDefined();
    // A palette entry that can only fail is worse than no entry (SPEC §6.5's command point
    // filters on `when`).
    expect(command?.when?.()).toBe(false);
  });
});

describe("the registry drives the parser", () => {
  const TEXT = "- [/] partial";

  it("renders an unregistered marker literally", () => {
    const host = fakeKernel();
    const api = activate(host.kernel);
    expect(hasComponent(api.render(TEXT), "TaskCheckbox")).toBe(false);
  });

  it("renders it as a checkbox once a plugin contributes the marker", () => {
    const host = fakeKernel();
    const api = activate(host.kernel);
    host.contribute<MarkdownTaskState>(POINTS.markdownTaskState, {
      marker: "/",
      label: "In progress",
      icon: "◐",
      order: 5,
    });
    expect(hasComponent(api.render(TEXT), "TaskCheckbox")).toBe(true);
    // And it takes its place in the menu order the contribution asked for.
    expect(api.taskStates().map((state) => state.marker)).toEqual([" ", "/", "x"]);
  });

  it("renders a contributed directive, and the same text literally without it", () => {
    const host = fakeKernel();
    const api = activate(host.kernel);
    const Note = (): ReactNode => null;
    expect(hasComponent(api.render(":::note\nhi\n:::"), "Note")).toBe(false);
    host.contribute(POINTS.markdownDirective, { name: "note", kind: "container", component: Note });
    expect(hasComponent(api.render(":::note\nhi\n:::"), "Note")).toBe(true);
  });

  it("announces contribution changes so cached renders can be refreshed", () => {
    const host = fakeKernel();
    const api = activate(host.kernel);
    const listener = vi.fn();
    const off = api.onChange(listener);
    host.contribute(POINTS.markdownFence, { language: "mermaid", component: (): ReactNode => null });
    expect(listener).toHaveBeenCalled();
    off();
    listener.mockClear();
    host.contribute(POINTS.markdownFence, { language: "chart", component: (): ReactNode => null });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("bodyOf and regions are part of the API", () => {
  const DOC = ["---", "title: Groceries", "---", "", "# Groceries", "", "%%% calendar", "a: 1", "%%%", ""].join("\n");

  it("gives viewer the body without the machine regions", () => {
    const api = activate(fakeKernel().kernel);
    expect(api.bodyOf(DOC)).toBe("\n# Groceries\n\n");
    expect(api.regions(DOC).frontmatter).toEqual({ start: 0, end: 25 });
  });

  it("renders a document body with no frontmatter leaking into the prose", () => {
    const api = activate(fakeKernel().kernel);
    const tree = api.render(api.bodyOf(DOC), { documentId: "01JBQ2X4Y5Z6A7B8C9D0E1F2G3" });
    expect(hasComponent(tree, "AttachmentImage")).toBe(false);
    // The `%%%` section's key never reaches the renderer.
    expect(JSON.stringify(tree)).not.toContain("calendar");
  });
});

describe("promoteToDocument (SPEC §3.6)", () => {
  it("creates a wrapper document from the attachment's metadata", async () => {
    const host = fakeKernel();
    const api: MarkdownApi = activate(host.kernel);
    const id = await api.promoteToDocument("01JATTACHMENT00000000000000");
    expect(id).toBe("01JNEWDOCUMENT0000000000000");
    expect(host.created).toEqual([
      ["---", "title: Scan 1.pdf", "---", "", "![Scan 1.pdf](attachment://01JATTACHMENT00000000000000)", ""].join(
        "\n",
      ),
    ]);
  });

  it.each([
    ["2026: notes.pdf", '"2026: notes.pdf"'],
    ["- dash.pdf", '"- dash.pdf"'],
    ["#hash.pdf", '"#hash.pdf"'],
    ["true", '"true"'],
    ['"quoted".pdf', '"\\"quoted\\".pdf"'],
  ])("quotes %j so the strict YAML subset still reads it as a string", async (name: string, expected: string) => {
    const host = fakeKernel(name);
    await activate(host.kernel).promoteToDocument("01JATTACHMENT00000000000000");
    expect(host.created[0]?.split("\n")[1]).toBe(`title: ${expected}`);
  });

  it("records fm.path when the file was promoted into a folder", async () => {
    const host = fakeKernel();
    const api = activate(host.kernel);
    await api.promoteToDocument("01JATTACHMENT00000000000000", { path: "home/scans" });
    expect(host.created[0]).toContain("path: home/scans");
  });
});
