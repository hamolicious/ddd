/**
 * `activate()` against a fake kernel: the wiring, not the pipeline.
 *
 * The pipeline suites call `renderTree` directly, which is the right level for "does this
 * markdown become that tree". What they cannot show is the half SPEC §6.6 is actually
 * about — that the **hosts** drive the parser. A marker becomes a checkbox because a
 * `markdown.taskState` item arrived on the `tasks` port, and the only way to prove that
 * end to end is to offer one the way another plugin would and re-render.
 *
 * The fake kernel below implements exactly the `kernel.ports` semantics
 * `kernel/src/runtime/ports.test.ts` pins — seat order (here: the order offered),
 * first-key-wins, live subscriptions, `entries()` with attribution — and nothing else.
 * It is ~80 lines because that is genuinely all of `@kernel` this plugin touches.
 */

import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";

import type { Kernel, SlotItem } from "@kernel";
import type { Command } from "@protocols/lm/commands.command";
import type { MarkdownTaskState } from "@protocols/lm/markdown.taskState";

import activate, { type MarkdownApi } from "./index.js";

// ---------------------------------------------------------------------------
// the fake kernel
// ---------------------------------------------------------------------------

/** This plugin's ports, as its manifest declares them: port name → protocol. */
const PORTS: Readonly<Record<string, string>> = {
  directives: "lm/markdown.directive",
  fences: "lm/markdown.fence",
  code: "lm/markdown.codeBlock",
  remark: "lm/markdown.remark",
  components: "lm/markdown.component",
  tasks: "lm/markdown.taskState",
  attachments: "lm/markdown.attachment",
  "task-states": "lm/markdown.taskState",
  settings: "lm/settings.section",
  commands: "lm/commands.command",
};

/** The protocols' duplicate keys (`protocol.json` `key`). */
const KEYS: Readonly<Record<string, (value: unknown) => string>> = {
  "lm/markdown.directive": (v) => `${(v as { kind: string }).kind}:${(v as { name: string }).name}`,
  "lm/markdown.fence": (v) => (v as { language: string }).language,
  "lm/markdown.taskState": (v) => (v as { marker: string }).marker,
};

interface FakeKernel {
  readonly kernel: Kernel;
  /** Offer on a protocol as some other plugin would; it takes the next seat. */
  offer<T>(protocol: string, value: T, pluginId?: string): void;
  values<T>(protocol: string): readonly T[];
  readonly collected: string[];
  readonly served: Map<string, unknown>;
  readonly created: string[];
  readonly notices: string[];
}

function fakeKernel(attachmentName = "Scan 1.pdf"): FakeKernel {
  const seats = new Map<string, SlotItem<unknown>[]>();
  const listeners = new Map<string, Set<(values: readonly unknown[]) => void>>();
  const collected: string[] = [];
  const served = new Map<string, unknown>();
  const created: string[] = [];
  const notices: string[] = [];

  const items = (protocol: string): readonly SlotItem<unknown>[] => seats.get(protocol) ?? [];
  const values = (protocol: string): readonly unknown[] => items(protocol).map((item) => item.value);
  const announce = (protocol: string): void => {
    for (const listener of listeners.get(protocol) ?? []) listener(values(protocol));
  };

  const seat = (protocol: string, port: string, value: unknown, pluginId: string): void => {
    const key = KEYS[protocol];
    // The earlier seat keeps a duplicate key, as the real host does.
    if (key && items(protocol).some((item) => key(item.value) === key(value))) return;
    const list = seats.get(protocol) ?? [];
    list.push({ pluginId, port, value });
    seats.set(protocol, list);
    announce(protocol);
  };
  const protocolOf = (port: string): string => {
    const protocol = PORTS[port];
    if (!protocol) throw new Error(`"markdown" has no port "${port}"`);
    return protocol;
  };

  const kernel = {
    pluginId: "markdown",
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    ports: {
      collect: <T,>(port: string) => {
        const protocol = protocolOf(port);
        collected.push(port);
        return {
          get: () => values(protocol) as readonly T[],
          entries: () => items(protocol) as readonly SlotItem<T>[],
          subscribe: (listener: (next: readonly T[]) => void) => {
            const set = listeners.get(protocol) ?? new Set();
            set.add(listener as (next: readonly unknown[]) => void);
            listeners.set(protocol, set);
            listener(values(protocol) as readonly T[]);
            return () => set.delete(listener as (next: readonly unknown[]) => void);
          },
        };
      },
      offer: <T,>(port: string, offered: T | readonly T[]) => {
        const protocol = protocolOf(port);
        for (const value of Array.isArray(offered) ? offered : [offered]) seat(protocol, port, value, "markdown");
        return { dispose: () => {} };
      },
      serve: <T,>(port: string, api: T) => {
        served.set(port, api);
        return { dispose: () => {} };
      },
      // `router` is optional and unbound here.
      use: () => undefined,
      bound: () => false,
    },
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
    offer: (protocol, value, pluginId = "some-plugin") => seat(protocol, `~${protocol}`, value, pluginId),
    values: <T,>(protocol: string) => values(protocol) as readonly T[],
    collected,
    served,
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
  it("collects the seven markdown.* ports", () => {
    const host = fakeKernel();
    activate(host.kernel);
    expect(host.collected).toEqual(["directives", "fences", "code", "remark", "components", "tasks", "attachments"]);
  });

  it("serves the renderer on its `renderer` port, and returns it too", () => {
    const host = fakeKernel();
    const api = activate(host.kernel);
    expect(host.served.get("renderer")).toBe(api);
  });

  it("ships [ ] and [x] as default taskState offers (SPEC §6.6)", () => {
    const host = fakeKernel();
    const api = activate(host.kernel);
    expect(api.taskStates().map((state) => state.marker)).toEqual([" ", "x"]);
    expect(api.taskStates().map((state) => state.done)).toEqual([false, true]);
  });

  it("registers the promote-to-document command, disabled until something is focused", () => {
    const host = fakeKernel();
    activate(host.kernel);
    const command = host.values<Command>("lm/commands.command").find((c) => c.id === "markdown.promoteToDocument");
    expect(command).toBeDefined();
    // A palette entry that can only fail is worse than no entry (SPEC §6.5's command point
    // filters on `when`).
    expect(command?.when?.()).toBe(false);
  });
});

describe("the hosts drive the parser", () => {
  const TEXT = "- [/] partial";

  it("renders an unregistered marker literally", () => {
    const host = fakeKernel();
    const api = activate(host.kernel);
    expect(hasComponent(api.render(TEXT), "TaskCheckbox")).toBe(false);
  });

  it("renders it as a checkbox once a plugin offers the marker", () => {
    const host = fakeKernel();
    const api = activate(host.kernel);
    host.offer<MarkdownTaskState>("lm/markdown.taskState", {
      marker: "/",
      label: "In progress",
      icon: "◐",
      order: 5,
    });
    expect(hasComponent(api.render(TEXT), "TaskCheckbox")).toBe(true);
  });

  it("lists task states in seat order, not by `order` (PLUGIN-PROTOCOLS §6a)", () => {
    const host = fakeKernel();
    const api = activate(host.kernel);
    // `order: 5` would once have put this between the built-ins; the host no longer
    // sorts, so a later seat is a later menu entry until the wiring moves it.
    host.offer<MarkdownTaskState>("lm/markdown.taskState", { marker: "/", label: "In progress", icon: "◐", order: 5 });
    expect(api.taskStates().map((state) => state.marker)).toEqual([" ", "x", "/"]);
  });

  it("takes the first seated code-block renderer, whatever its `order`", () => {
    const host = fakeKernel();
    const api = activate(host.kernel);
    const First = (): ReactNode => null;
    const Second = (): ReactNode => null;
    host.offer("lm/markdown.codeBlock", { id: "first", component: First, order: 100 }, "plugin-a");
    host.offer("lm/markdown.codeBlock", { id: "second", component: Second, order: 0 }, "plugin-b");
    const tree = api.render("```ts\nlet x = 1;\n```");
    expect(hasComponent(tree, "First")).toBe(true);
    expect(hasComponent(tree, "Second")).toBe(false);
  });

  it("renders an offered directive, and the same text literally without it", () => {
    const host = fakeKernel();
    const api = activate(host.kernel);
    const Note = (): ReactNode => null;
    expect(hasComponent(api.render(":::note\nhi\n:::"), "Note")).toBe(false);
    host.offer("lm/markdown.directive", { name: "note", kind: "container", component: Note });
    expect(hasComponent(api.render(":::note\nhi\n:::"), "Note")).toBe(true);
  });

  it("announces port changes so cached renders can be refreshed", () => {
    const host = fakeKernel();
    const api = activate(host.kernel);
    const listener = vi.fn();
    const off = api.onChange(listener);
    host.offer("lm/markdown.fence", { language: "mermaid", component: (): ReactNode => null });
    expect(listener).toHaveBeenCalled();
    off();
    listener.mockClear();
    host.offer("lm/markdown.fence", { language: "chart", component: (): ReactNode => null });
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

  it("files the new document where \"Files go to\" says, through `folders`", async () => {
    const host = fakeKernel();
    const filed: [string, string][] = [];
    const ports = host.kernel.ports as unknown as { bound: (port: string) => boolean; use: (port: string) => unknown };
    ports.bound = (port) => port === "folders";
    ports.use = (port) =>
      port === "folders"
        ? { fileNew: async (id: string, kind: string) => void filed.push([id, kind]) }
        : undefined;
    const id = await activate(host.kernel).promoteToDocument("01JATTACHMENT00000000000000");
    expect(filed).toEqual([[id, "file"]]);
    expect(host.created[0]).not.toMatch(/^path:/m);
  });
});
