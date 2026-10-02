import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";

import type { Kernel } from "@kernel";
import type { Command } from "plugin:commands";
import type { SettingsSection } from "plugin:settings";

const added = vi.hoisted(() => ({ commands: [] as unknown[], sections: [] as unknown[] }));

vi.mock("plugin:commands", () => ({
  addCommand: (command: unknown) => {
    added.commands.push(command);
    return () => void added.commands.splice(added.commands.indexOf(command), 1);
  },
}));
vi.mock("plugin:settings", () => ({
  addSection: (section: unknown) => {
    added.sections.push(section);
    return () => void added.sections.splice(added.sections.indexOf(section), 1);
  },
}));

import activate, {
  addCodeBlockRenderer,
  addDirective,
  addFence,
  addTaskState,
  bodyOf,
  deactivate,
  onChange,
  promoteToDocument,
  regions,
  render,
  taskStates,
} from "./index.js";

interface FakeKernel {
  readonly kernel: Kernel;
  readonly created: string[];
  readonly notices: string[];
}

function fakeKernel(attachmentName = "Scan 1.pdf", optional: Record<string, unknown> = {}): FakeKernel {
  const created: string[] = [];
  const notices: string[] = [];

  const kernel = {
    pluginId: "markdown",
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    plugins: {
      active: (id: string) => id in optional,
      optional: (id: string) => Promise.resolve(optional[id]),
      list: () => [],
    },
    settings: {
      defineSchema: () => {},
      subscribe: () => () => {},
      get: () => undefined,
    },
    ui: {
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

  return { kernel, created, notices };
}

const removers: (() => void)[] = [];
const keep = (remove: () => void): void => void removers.push(remove);

afterEach(() => {
  for (const remove of removers.splice(0)) remove();
  deactivate();
});

function hasComponent(node: ReactNode, name: string): boolean {
  if (Array.isArray(node)) return node.some((child) => hasComponent(child as ReactNode, name));
  if (!isValidElement(node)) return false;
  if (typeof node.type === "function" && node.type.name === name) return true;
  return hasComponent((node.props as { children?: ReactNode }).children, name);
}

describe("activate", () => {
  it("ships [ ] and [x] as default task states (SPEC §6.6)", async () => {
    await activate(fakeKernel().kernel);
    expect(taskStates().map((state) => state.marker)).toEqual([" ", "x"]);
    expect(taskStates().map((state) => state.done)).toEqual([false, true]);
  });

  it("takes its own task states out again on deactivate", async () => {
    await activate(fakeKernel().kernel);
    deactivate();
    expect(taskStates()).toEqual([]);
  });

  it("adds the promote-to-document command, disabled until something is focused", async () => {
    await activate(fakeKernel().kernel);
    const command = (added.commands as Command[]).find((c) => c.id === "markdown.promoteToDocument");
    expect(command).toBeDefined();
    expect(command?.when?.()).toBe(false);
  });

  it("adds its settings section", async () => {
    await activate(fakeKernel().kernel);
    expect((added.sections as SettingsSection[]).map((section) => section.id)).toEqual(["markdown"]);
  });

  it("adds its menu actions to context-menu when that plugin is enabled", async () => {
    const actions: unknown[] = [];
    const menu = { addAction: (items: unknown) => (actions.push(items), () => {}), openFor: () => true };
    await activate(fakeKernel(undefined, { "context-menu": menu }).kernel);
    expect(actions).toHaveLength(1);
  });

  it("throws a clear error when rendering before activation", () => {
    expect(() => render("hi")).toThrow(/not active/);
  });
});

describe("the registries drive the parser", () => {
  const TEXT = "- [/] partial";

  it("renders an unregistered marker literally", async () => {
    await activate(fakeKernel().kernel);
    expect(hasComponent(render(TEXT), "TaskCheckbox")).toBe(false);
  });

  it("renders it as a checkbox once a plugin adds the marker", async () => {
    await activate(fakeKernel().kernel);
    keep(addTaskState({ marker: "/", label: "In progress", icon: "◐", order: 5 }));
    expect(hasComponent(render(TEXT), "TaskCheckbox")).toBe(true);
  });

  it("lists task states by `order`", async () => {
    await activate(fakeKernel().kernel);
    keep(addTaskState({ marker: "/", label: "In progress", icon: "◐", order: 5 }));
    keep(addTaskState({ marker: "-", label: "Dropped", icon: "–" }));
    expect(taskStates().map((state) => state.marker)).toEqual([" ", "/", "x", "-"]);
  });

  it("takes the first code-block renderer in `order`", async () => {
    await activate(fakeKernel().kernel);
    const First = (): ReactNode => null;
    const Second = (): ReactNode => null;
    keep(addCodeBlockRenderer({ id: "first", component: First, order: 100 }));
    keep(addCodeBlockRenderer({ id: "second", component: Second, order: 0 }));
    const tree = render("```ts\nlet x = 1;\n```");
    expect(hasComponent(tree, "Second")).toBe(true);
    expect(hasComponent(tree, "First")).toBe(false);
  });

  it("renders an added directive, and the same text literally without it", async () => {
    await activate(fakeKernel().kernel);
    const Note = (): ReactNode => null;
    expect(hasComponent(render(":::note\nhi\n:::"), "Note")).toBe(false);
    keep(addDirective({ name: "note", kind: "container", component: Note }));
    expect(hasComponent(render(":::note\nhi\n:::"), "Note")).toBe(true);
  });

  it("rejects a malformed contribution", () => {
    expect(() => addFence({ language: 3 } as never)).toThrow();
  });

  it("announces changes so cached renders can be refreshed", async () => {
    await activate(fakeKernel().kernel);
    const listener = vi.fn();
    const off = onChange(listener);
    keep(addFence({ language: "mermaid", component: (): ReactNode => null }));
    expect(listener).toHaveBeenCalled();
    off();
    listener.mockClear();
    keep(addFence({ language: "chart", component: (): ReactNode => null }));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("bodyOf and regions are part of the API", () => {
  const DOC = ["---", "title: Groceries", "---", "", "# Groceries", "", "%%% calendar", "a: 1", "%%%", ""].join("\n");

  it("gives viewer the body without the machine regions", () => {
    expect(bodyOf(DOC)).toBe("\n# Groceries\n\n");
    expect(regions(DOC).frontmatter).toEqual({ start: 0, end: 25 });
  });

  it("renders a document body with no frontmatter leaking into the prose", async () => {
    await activate(fakeKernel().kernel);
    const tree = render(bodyOf(DOC), { documentId: "01JBQ2X4Y5Z6A7B8C9D0E1F2G3" });
    expect(hasComponent(tree, "AttachmentImage")).toBe(false);
    expect(JSON.stringify(tree)).not.toContain("calendar");
  });
});

describe("promoteToDocument (SPEC §3.6)", () => {
  it("creates a wrapper document from the attachment's metadata", async () => {
    const host = fakeKernel();
    await activate(host.kernel);
    const id = await promoteToDocument("01JATTACHMENT00000000000000");
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
    await activate(host.kernel);
    await promoteToDocument("01JATTACHMENT00000000000000");
    expect(host.created[0]?.split("\n")[1]).toBe(`title: ${expected}`);
  });

  it("files the new document where \"Files go to\" says, through `folders`", async () => {
    const filed: [string, string][] = [];
    const folders = {
      fileNew: async (id: string, kind: string) => void filed.push([id, kind]),
      look: () => undefined,
      onLookChange: () => () => {},
    };
    const host = fakeKernel(undefined, { folders });
    await activate(host.kernel);
    const id = await promoteToDocument("01JATTACHMENT00000000000000");
    expect(filed).toEqual([[id, "file"]]);
    expect(host.created[0]).not.toMatch(/^path:/m);
  });
});
