/**
 * Pipeline tests: markdown text in, React element tree out.
 *
 * The tree is serialized by `show()` below rather than rendered to HTML. Two reasons, and
 * the second is the one that matters:
 *
 * - `react-dom/server` is not reachable from `plugins/base/**` (see `mdast.ts` on why the
 *   type-only packages are not in `web/tsconfig.json`'s `paths`), and the suites run in
 *   `environment: "node"` with no DOM at all, like every kernel suite.
 * - Rendering to HTML would *erase the assertion*. `<DocLink id="…">` and
 *   `<AttachmentImage>` are exactly what these tests are about — that a `doc://` link
 *   became the component that resolves a title from the projection, and not an `<a>` with
 *   a scheme the browser cannot follow. HTML would show the components' output; the
 *   element tree shows the decision.
 */

import { describe, expect, it } from "vitest";
import { createElement, isValidElement, type ReactNode } from "react";

import type { MarkdownAttachmentProps } from "@protocols/lm/markdown.attachment";
import type { MarkdownCodeBlockProps } from "@protocols/lm/markdown.codeBlock";
import type { MarkdownDirectiveProps } from "@protocols/lm/markdown.directive";
import type { MarkdownFenceProps } from "@protocols/lm/markdown.fence";
import type { MarkdownTaskState } from "@protocols/lm/markdown.taskState";

import { buildProcessor } from "./processor.js";
import { renderTree, type RenderOptions, type RenderRegistries } from "./render.js";
import type { MarkdownRuntime } from "./runtime.js";
import { buildTaskRegistry, scanTasks } from "./tasks.js";

const ULID = "01JBQ2X4Y5Z6A7B8C9D0E1F2G3";
const OTHER = "01JBQ2X4Y5Z6A7B8C9D0E1F2G4";

const TODO: MarkdownTaskState = { marker: " ", label: "To do", icon: "☐", order: 0, done: false };
const DONE: MarkdownTaskState = { marker: "x", label: "Done", icon: "☑", order: 10, done: true };
const PARTIAL: MarkdownTaskState = { marker: "/", label: "In progress", icon: "◐", order: 5 };

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** The runtime is a seam, not a dependency: nothing here touches IndexedDB or a socket. */
const RUNTIME = {
  kernel: {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    ui: { notify: () => () => {} },
  },
} as unknown as MarkdownRuntime;

interface Registries {
  readonly tasks?: readonly MarkdownTaskState[];
  readonly directives?: Record<string, (props: MarkdownDirectiveProps) => ReactNode>;
  readonly fences?: Record<string, (props: MarkdownFenceProps) => ReactNode>;
  readonly overrides?: Record<string, (props: Record<string, unknown>) => ReactNode>;
  readonly attachment?: (props: MarkdownAttachmentProps) => ReactNode;
  readonly codeBlock?: (props: MarkdownCodeBlockProps) => ReactNode;
}

function registriesOf(options: Registries = {}): RenderRegistries {
  return {
    directives: new Map(Object.entries(options.directives ?? {})) as RenderRegistries["directives"],
    fences: new Map(Object.entries(options.fences ?? {})) as RenderRegistries["fences"],
    overrides: new Map(Object.entries(options.overrides ?? {})) as RenderRegistries["overrides"],
    tasks: buildTaskRegistry(options.tasks ?? [TODO, DONE]),
    attachment: options.attachment,
    codeBlock: options.codeBlock,
  };
}

/**
 * Parse and render, the way `activate()` wires it together.
 *
 * `documentId` defaults to **undefined** so it stays out of most expectations; the tests
 * that care about it pass one.
 */
function render(
  text: string,
  options: Registries & { readonly documentId?: string; readonly embeds?: RenderOptions["embeds"] } = {},
): string {
  const processor = buildProcessor([]);
  const registries = registriesOf(options);
  const tree = processor.parse(text);
  return show(
    renderTree(tree, text, {
      documentId: options.documentId,
      offset: undefined,
      registries,
      runtime: RUNTIME,
      taskScan: scanTasks(tree, text, registries.tasks),
      rescan: (body) => scanTasks(processor.parse(body), body, registries.tasks),
      embeds: options.embeds,
    }),
  );
}

/** Props worth showing: the ones a reviewer would check, in a stable order. */
const SHOWN = [
  "id",
  "className",
  "href",
  "src",
  "alt",
  "title",
  "start",
  "role",
  "scope",
  "aria-checked",
  "disabled",
  "target",
  "rel",
  "language",
  "code",
  "meta",
  "label",
  "attributes",
  "node",
  "documentId",
] as const;

/** Serialize a React element tree to an indented, diffable string. */
function show(node: ReactNode, indent = ""): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") {
    const text = String(node);
    return text.length === 0 ? "" : `${indent}${JSON.stringify(text)}\n`;
  }
  if (Array.isArray(node)) {
    return node.map((child) => show(child as ReactNode, indent)).join("");
  }
  if (!isValidElement(node)) return `${indent}?${String(node)}\n`;

  const props = node.props as Record<string, unknown>;
  const children = props["children"] as ReactNode;
  const name =
    typeof node.type === "string"
      ? node.type
      : typeof node.type === "function"
        ? (node.type.name || "Anonymous")
        : "";

  // A Fragment has no name of its own; its children stand in for it.
  if (name === "") return show(children, indent);

  const attributes = SHOWN.filter((key) => props[key] !== undefined)
    .map((key) => {
      const value = props[key];
      // Tailwind utilities are presentation details. Keep the renderer's stable semantic
      // hooks in snapshots so a visual refactor does not rewrite every pipeline fixture.
      if (key === "className" && typeof value === "string") {
        const stable = value
          .split(/\s+/)
          .filter((name) => name.startsWith("md-") || name.startsWith("language-"))
          .join(" ");
        return `${key}=${JSON.stringify(stable || value)}`;
      }
      // An mdast node is identified by its type; printing the whole node would bury the
      // assertion in position objects.
      if (key === "node") return `node=${JSON.stringify((value as { type: string }).type)}`;
      // A React node as a prop (`DocLink`'s label) is shown as `<node>`, not as its
      // internal representation — element internals are React's business, not a fixture's.
      if (typeof value === "object" && value !== null) {
        return isValidElement(value) || Array.isArray(value) ? `${key}=<node>` : `${key}=${JSON.stringify(value)}`;
      }
      return `${key}=${JSON.stringify(value)}`;
    })
    .join(" ");

  const open = attributes.length > 0 ? `<${name} ${attributes}>` : `<${name}>`;
  const inner = show(children, `${indent}  `);
  return inner.length === 0
    ? `${indent}${open.slice(0, -1)} />\n`
    : `${indent}${open}\n${inner}${indent}</${name}>\n`;
}

// ---------------------------------------------------------------------------
// the whole pipeline, once
// ---------------------------------------------------------------------------

describe("the pipeline, end to end", () => {
  const DOCUMENT = [
    "# Groceries",
    "",
    "Buy **milk** and *bread*, ~~not~~ eggs. Use `git status`.",
    "",
    "- [ ] milk",
    "- [x] bread",
    "",
    "> a quote",
    "",
    "| item | qty |",
    "| :--- | --: |",
    "| milk | 2 |",
    "",
    "```js",
    "const x = 1;",
    "```",
    "",
    "---",
    "",
    "See [the other list](doc://" + OTHER + ") and <https://example.com/a>.",
  ].join("\n");

  it("renders a representative document", () => {
    expect(render(DOCUMENT)).toBe(
      [
        '<div className="md-root">',
        '  <h1 id="groceries">',
        '    "Groceries"',
        "  </h1>",
        "  <p>",
        '    "Buy "',
        "    <strong>",
        '      "milk"',
        "    </strong>",
        '    " and "',
        "    <em>",
        '      "bread"',
        "    </em>",
        '    ", "',
        "    <del>",
        '      "not"',
        "    </del>",
        '    " eggs. Use "',
        '    <code className="md-inline-code">',
        '      "git status"',
        "    </code>",
        '    "."',
        "  </p>",
        '  <ul className="md-list">',
        '    <li className="md-item md-task">',
        "      <TaskCheckbox />",
        '      <span className="md-task-body">',
        "        <p>",
        '          "milk"',
        "        </p>",
        "      </span>",
        "    </li>",
        '    <li className="md-item md-task md-task-done">',
        "      <TaskCheckbox />",
        '      <span className="md-task-body">',
        "        <p>",
        '          "bread"',
        "        </p>",
        "      </span>",
        "    </li>",
        "  </ul>",
        "  <blockquote>",
        "    <p>",
        '      "a quote"',
        "    </p>",
        "  </blockquote>",
        '  <div className="md-table-scroll">',
        '    <table className="md-table">',
        "      <thead>",
        "        <tr>",
        '          <th scope="col">',
        '            "item"',
        "          </th>",
        '          <th scope="col">',
        '            "qty"',
        "          </th>",
        "        </tr>",
        "      </thead>",
        "      <tbody>",
        "        <tr>",
        "          <td>",
        '            "milk"',
        "          </td>",
        "          <td>",
        '            "2"',
        "          </td>",
        "        </tr>",
        "      </tbody>",
        "    </table>",
        "  </div>",
        '  <pre className="md-code">',
        '    <code className="language-js">',
        '      "const x = 1;"',
        "    </code>",
        "  </pre>",
        "  <hr />",
        "  <p>",
        '    "See "',
        '    <DocLink id="' + OTHER + '" label=<node> />',
        '    " and "',
        '    <a className="md-link" href="https://example.com/a" target="_blank" rel="noopener noreferrer">',
        '      "https://example.com/a"',
        "    </a>",
        '    "."',
        "  </p>",
        "</div>",
        "",
      ].join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// the extension points
// ---------------------------------------------------------------------------

describe("markdown.directive", () => {
  const Note = (): ReactNode => null;

  it("renders a registered container directive, label separated from body", () => {
    const tree = render(":::note[Watch out]{kind=warn}\nbody text\n:::", {
      directives: { "container:note": Note },
    });
    expect(tree).toContain('<Note label="Watch out" attributes={"kind":"warn"}');
    expect(tree).toContain('"body text"');
    // The label paragraph is passed as `label` and *not also* left in the children, or
    // every contributed component would render its own title twice.
    expect(tree.match(/Watch out/g)).toHaveLength(1);
  });

  it("renders registered leaf and text directives", () => {
    expect(render("::stamp[now]{tz=utc}", { directives: { "leaf:stamp": Note } })).toContain(
      '<Note label="now" attributes={"tz":"utc"}',
    );
    expect(render("an :abbr[HTML] thing", { directives: { "text:abbr": Note } })).toContain(
      '<Note label="HTML"',
    );
  });

  it("degrades an unregistered directive to its literal source (SPEC §6.6)", () => {
    // The whole reason directives are the blessed syntax: no plugin, no mystery.
    expect(render(":::note[Hi]\nbody\n:::")).toBe(
      [
        '<div className="md-root">',
        '  <div className="md-literal md-literal-block" title="no renderer for :note">',
        '    ":::note[Hi]\\nbody\\n:::"',
        "  </div>",
        "</div>",
        "",
      ].join("\n"),
    );
    expect(render("an :abbr[HTML] thing")).toContain('<span className="md-literal" title="no renderer for :abbr">');
  });

  it("only reads a text directive at the start of a word", () => {
    // `18:00` and `a:emoji` are prose, not directives.
    expect(render("Time: 18:00 - 20:30")).not.toContain("md-literal");
    expect(render("a:emoji here", { directives: { "text:emoji": Note } })).not.toContain("Note");
    expect(render("Time: 18:00")).toContain('"Time: 18:00"');
    expect(render("a :emoji here", { directives: { "text:emoji": Note } })).toContain("Note");
    expect(render("(:emoji)", { directives: { "text:emoji": Note } })).toContain("Note");
    // `:x` right after a closing shortcode colon is glued too.
    expect(render(":tada:x", { directives: { "text:x": Note } })).not.toContain("Note");
  });

  it("does not let a container renderer claim a text directive of the same name", () => {
    expect(render("an :note[x] thing", { directives: { "container:note": Note } })).toContain("md-literal");
  });
});

describe("markdown.fence", () => {
  const Mermaid = (): ReactNode => null;

  it("hands a claimed language its code and meta", () => {
    expect(
      render("```mermaid twoColumns\ngraph TD\n```", { fences: { mermaid: Mermaid }, documentId: ULID }),
    ).toContain(`<Mermaid code="graph TD" meta="twoColumns" documentId="${ULID}" />`);
  });

  it("falls back to a code block for an unclaimed language", () => {
    expect(render("```mermaid\ngraph TD\n```")).toContain('<code className="language-mermaid">');
  });

  it("renders a fence with no language as a plain code block", () => {
    expect(render("```\nplain\n```")).toContain('<pre className="md-code">');
  });
});

describe("markdown.codeBlock", () => {
  const Mermaid = (): ReactNode => null;
  const Highlighted = (): ReactNode => null;

  it("renders fenced code no fence claims", () => {
    expect(render("```rust {1}\nfn main() {}\n```", { codeBlock: Highlighted, documentId: ULID })).toContain(
      `<Highlighted language="rust" code="fn main() {}" meta="{1}" documentId="${ULID}" />`,
    );
  });

  it("renders a fence with no language, without one", () => {
    expect(render("```\nplain\n```", { codeBlock: Highlighted })).toContain('<Highlighted code="plain" />');
  });

  it("leaves a claimed language to its fence", () => {
    expect(render("```mermaid\ngraph TD\n```", { fences: { mermaid: Mermaid }, codeBlock: Highlighted })).toContain(
      "<Mermaid",
    );
  });
});

describe("markdown.component", () => {
  const Callout = (): ReactNode => null;

  it("overrides the renderer for one mdast node type", () => {
    const tree = render("> quoted", { overrides: { blockquote: Callout } });
    expect(tree).toContain('<Callout node="blockquote"');
    expect(tree).not.toContain("<blockquote>");
  });

  it("receives the node's children already rendered", () => {
    const tree = render("> quoted", { overrides: { blockquote: Callout } });
    expect(tree).toContain('"quoted"');
  });
});

describe("markdown.remark", () => {
  it("applies a contributed plugin in order, before rendering", () => {
    /** A transformer that rewrites every text node. Deliberately trivial and synchronous. */
    const shout = () => (tree: { children?: { type: string; value?: string }[] }) => {
      const visit = (node: { type: string; value?: string; children?: never[] }): void => {
        if (node.type === "text" && typeof node.value === "string") node.value = node.value.toUpperCase();
        for (const child of node.children ?? []) visit(child);
      };
      visit(tree as never);
    };

    const processor = buildProcessor([{ id: "shout", plugin: shout }]);
    const registries = registriesOf();
    const text = "hello";
    const parsed = processor.parse(text);
    const out = show(
      renderTree(parsed, text, {
        documentId: ULID,
        offset: undefined,
        registries,
        runtime: RUNTIME,
        taskScan: scanTasks(parsed, text, registries.tasks),
        rescan: () => scanTasks(parsed, text, registries.tasks),
      }),
    );
    expect(out).toContain('"HELLO"');
  });
});

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

describe("task rendering", () => {
  it("renders a registered marker as a checkbox and strips the marker from the text", () => {
    const tree = render("- [/] partial", { tasks: [TODO, PARTIAL, DONE] });
    expect(tree).toContain("<TaskCheckbox />");
    expect(tree).toContain('"partial"');
    expect(tree).not.toContain("[/]");
  });

  it("renders an unregistered marker literally, even one remark-gfm consumed", () => {
    // `[X]` is GFM's, not the registry's: GFM removed it from the paragraph, so it has to
    // be put back or the document silently loses a character the author typed.
    const shouty = render("- [X] shouty");
    // Inside the paragraph, not as a sibling of it: a bare string next to the item's
    // paragraph would put the marker on its own line.
    expect(shouty).toContain('"[X] shouty"');
    expect(shouty).not.toContain("TaskCheckbox");

    // `[?]` was never touched by GFM, so it is already in the text.
    const unclear = render("- [?] unclear");
    expect(unclear).toContain('"[?] unclear"');
    expect(unclear).not.toContain("TaskCheckbox");
  });

  it("marks the done state on the item, for styling only", () => {
    expect(render("- [x] bread")).toContain("md-task md-task-done");
    expect(render("- [ ] milk")).toContain('<li className="md-item md-task">');
  });

  it("leaves a plain list item alone", () => {
    const tree = render("- plain");
    expect(tree).toContain('<li className="md-item">');
    expect(tree).not.toContain("md-task");
  });

  it("renders every marker literally when nothing is registered", () => {
    // The documented consequence of registry-driven semantics (SPEC §6.6): a client
    // without the contributing plugin sees markers as text.
    const tree = render("- [ ] milk\n- [x] bread", { tasks: [] });
    expect(tree).not.toContain("TaskCheckbox");
    expect(tree).toContain('"[ ] milk"');
    expect(tree).toContain('"[x] bread"');
  });

  it("handles tasks in nested and ordered lists", () => {
    expect(render("1. [x] first")).toContain("<TaskCheckbox />");
    expect(render("- outer\n  - [ ] nested")).toContain("<TaskCheckbox />");
  });
});

// ---------------------------------------------------------------------------
// schemes, in the renderer
// ---------------------------------------------------------------------------

describe("links and images", () => {
  it("routes doc:// to the resolver, not to an href the browser cannot follow", () => {
    expect(render(`[x](doc://${OTHER})`)).toContain(`<DocLink id="${OTHER}"`);
  });

  it("routes attachment:// to a chip, and an image embed to the image renderer", () => {
    expect(render(`[file](attachment://${ULID})`)).toContain(`<AttachmentChip id="${ULID}" alt="file" />`);
    expect(render(`![shot](attachment://${ULID})`)).toContain(`<AttachmentImage id="${ULID}" alt="shot" />`);
  });

  it("hands an embed to the markdown.attachment renderer, with its own image as the fallback", () => {
    const Renderer = (_props: MarkdownAttachmentProps): ReactNode => null;
    const out = render(`![shot](attachment://${ULID})`, { attachment: Renderer });
    expect(out).toContain(`<Renderer id="${ULID}" alt="shot" />`);
    expect(out).not.toContain("<AttachmentImage");
    // A link is still a chip: only embeds are the renderer's.
    expect(render(`[file](attachment://${ULID})`, { attachment: Renderer })).toContain("<AttachmentChip");
  });

  it("embeds a doc:// image within the depth, as a block, and links past it or in a cycle", () => {
    const embeds = (depth: number, ancestors: readonly string[] = []) => ({
      chain: { depth, ancestors },
      maxDepth: 4,
      renderBody: () => null,
    });
    const embedded = render(`![](doc://${OTHER})`, { embeds: embeds(0) });
    expect(embedded).toContain(`<DocEmbed id="${OTHER}"`);
    expect(embedded).not.toContain("<p>");
    expect(render(`![](doc://${OTHER})`, { embeds: embeds(4) })).toContain(`<DocLink id="${OTHER}"`);
    expect(render(`![](doc://${OTHER})`, { embeds: embeds(1, [OTHER]) })).toContain(`<DocLink id="${OTHER}"`);
    // No embeds configured at all: a link, as before.
    expect(render(`![](doc://${OTHER})`)).toContain(`<DocLink id="${OTHER}"`);
  });

  it("opens http(s) links in a new tab with noopener", () => {
    expect(render("[a](https://example.com)")).toContain('rel="noopener noreferrer"');
  });

  it("keeps mailto in the same tab", () => {
    const tree = render("[mail](mailto:a@b.c)");
    expect(tree).toContain('href="mailto:a@b.c"');
    expect(tree).not.toContain('target="_blank"');
  });

  it("renders an in-page anchor", () => {
    expect(render("[top](#groceries)")).toContain('<a className="md-anchor" href="#groceries">');
  });

  it("renders a blocked destination as the literal markdown, with no href at all", () => {
    const tree = render("[bad](javascript:alert(1))");
    expect(tree).toContain('<span className="md-literal"');
    expect(tree).toContain('"[bad](javascript:alert(1))"');
    expect(tree).not.toContain("href");
  });

  it.each([
    "![x](javascript:alert(1))",
    "![x](data:text/html;base64,PHNjcmlwdD4=)",
    "![x](vbscript:msgbox(1))",
    "![x](./local.png)",
    "![x](//evil.example/x.png)",
  ])("renders %s with no src", (source: string) => {
    const tree = render(source);
    expect(tree).not.toContain("src=");
    expect(tree).toContain("md-literal");
  });

  it("resolves reference-style links through their definition, allowlist included", () => {
    expect(render("[a][ref]\n\n[ref]: https://example.com")).toContain('href="https://example.com"');
    expect(render("[a][ref]\n\n[ref]: javascript:alert(1)")).not.toContain("href");
    // A reference with no definition never becomes a link node at all — remark leaves it
    // as text, so there is nothing for the allowlist to refuse and nothing to click.
    expect(render("[a][missing]")).toContain('"[a][missing]"');
  });
});

describe("raw HTML (SPEC §8: no passthrough in v1)", () => {
  it.each(["<script>alert(1)</script>", "<div onclick='x'>hi</div>", "<img src=x onerror=alert(1)>"])(
    "prints the block %s as a text child",
    (source: string) => {
      const tree = render(source);
      expect(tree).toContain("md-raw-html");
      // The tags are a *string*, which is what `JSON.stringify` around them proves: React
      // escapes a string child, so there is no element and no attribute to fire.
      expect(tree).toContain(JSON.stringify(source));
    },
  );

  it("prints inline HTML as text too", () => {
    const tree = render("text with <b>bold</b> inline");
    expect(tree).toContain('"<b>"');
    expect(tree).toContain('"</b>"');
    expect(tree).toContain("md-raw-html");
  });

  it("never produces a dangerouslySetInnerHTML prop anywhere in the tree", () => {
    const tree = render("<img src=x onerror=alert(1)>\n\n*fine*");
    expect(tree).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("robustness", () => {
  it("renders an empty document without throwing", () => {
    expect(render("")).toBe('<div className="md-root" />\n');
  });

  it("renders an unknown node type from a remark plugin as its source", () => {
    // Belt and braces for the escalated path: a plugin that invents a node type gets its
    // source text shown rather than a hole in the document.
    const invent = () => (tree: { children: unknown[] }) => {
      tree.children = [{ type: "inventedThing", position: { start: { offset: 0 }, end: { offset: 5 } } }];
    };
    const processor = buildProcessor([{ id: "invent", plugin: invent }]);
    const registries = registriesOf();
    const text = "hello world";
    const parsed = processor.parse(text);
    const out = show(
      renderTree(parsed, text, {
        documentId: ULID,
        offset: undefined,
        registries,
        runtime: RUNTIME,
        taskScan: scanTasks(parsed, text, registries.tasks),
        rescan: () => scanTasks(parsed, text, registries.tasks),
      }),
    );
    expect(out).toContain('"hello"');
  });

  it("gives headings stable anchor ids", () => {
    expect(render("## Shopping List!")).toContain('id="shopping-list"');
    expect(render("## ???")).toContain('id="section"');
  });

  it("keeps element keys stable across two renders of the same text", () => {
    const text = "# a\n\n- [ ] b";
    expect(render(text)).toBe(render(text));
  });

  it("does not crash on a table with no body rows", () => {
    expect(render("| a |\n| - |")).toContain("md-table");
  });
});

describe("show() — the serializer itself", () => {
  it("prints a fragment's children without a wrapper", () => {
    expect(show(createElement("b", null, "x"))).toBe('<b>\n  "x"\n</b>\n');
  });
});
