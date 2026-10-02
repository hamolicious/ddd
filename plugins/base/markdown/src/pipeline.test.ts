import { describe, expect, it } from "vitest";
import { createElement, isValidElement, type ReactNode } from "react";

import type { MarkdownAttachmentProps } from "./api.js";
import type { MarkdownCodeBlockProps } from "./api.js";
import type { MarkdownDirectiveProps } from "./api.js";
import type { MarkdownFenceProps } from "./api.js";
import type { MarkdownTaskState } from "./api.js";

import { buildProcessor } from "./processor.js";
import { renderTree, type RenderOptions, type RenderRegistries } from "./render.js";
import type { MarkdownRuntime } from "./runtime.js";
import { buildTaskRegistry, scanTasks } from "./tasks.js";

const ULID = "01JBQ2X4Y5Z6A7B8C9D0E1F2G3";
const OTHER = "01JBQ2X4Y5Z6A7B8C9D0E1F2G4";

const TODO: MarkdownTaskState = { marker: " ", label: "To do", icon: "☐", order: 0, done: false };
const DONE: MarkdownTaskState = { marker: "x", label: "Done", icon: "☑", order: 10, done: true };
const PARTIAL: MarkdownTaskState = { marker: "/", label: "In progress", icon: "◐", order: 5 };

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

  if (name === "") return show(children, indent);

  const attributes = SHOWN.filter((key) => props[key] !== undefined)
    .map((key) => {
      const value = props[key];
      if (key === "className" && typeof value === "string") {
        const stable = value
          .split(/\s+/)
          .filter((name) => name.startsWith("md-") || name.startsWith("language-"))
          .join(" ");
        return `${key}=${JSON.stringify(stable || value)}`;
      }
      if (key === "node") return `node=${JSON.stringify((value as { type: string }).type)}`;
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

describe("markdown.directive", () => {
  const Note = (): ReactNode => null;

  it("renders a registered container directive, label separated from body", () => {
    const tree = render(":::note[Watch out]{kind=warn}\nbody text\n:::", {
      directives: { "container:note": Note },
    });
    expect(tree).toContain('<Note label="Watch out" attributes={"kind":"warn"}');
    expect(tree).toContain('"body text"');
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
    expect(render("Time: 18:00 - 20:30")).not.toContain("md-literal");
    expect(render("a:emoji here", { directives: { "text:emoji": Note } })).not.toContain("Note");
    expect(render("Time: 18:00")).toContain('"Time: 18:00"');
    expect(render("a :emoji here", { directives: { "text:emoji": Note } })).toContain("Note");
    expect(render("(:emoji)", { directives: { "text:emoji": Note } })).toContain("Note");
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

describe("task rendering", () => {
  it("renders a registered marker as a checkbox and strips the marker from the text", () => {
    const tree = render("- [/] partial", { tasks: [TODO, PARTIAL, DONE] });
    expect(tree).toContain("<TaskCheckbox />");
    expect(tree).toContain('"partial"');
    expect(tree).not.toContain("[/]");
  });

  it("renders an unregistered marker literally, even one remark-gfm consumed", () => {
    const shouty = render("- [X] shouty");
    expect(shouty).toContain('"[X] shouty"');
    expect(shouty).not.toContain("TaskCheckbox");

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
    expect(render("[a][missing]")).toContain('"[a][missing]"');
  });
});

describe("raw HTML (SPEC §8: no passthrough in v1)", () => {
  it.each(["<script>alert(1)</script>", "<div onclick='x'>hi</div>", "<img src=x onerror=alert(1)>"])(
    "prints the block %s as a text child",
    (source: string) => {
      const tree = render(source);
      expect(tree).toContain("md-raw-html");
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
