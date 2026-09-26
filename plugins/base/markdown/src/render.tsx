/**
 * mdast → React. The other half of the pipeline (SPEC §6.6), and the place the security
 * rules are actually enforced.
 *
 * **Why there is no rehype stage.** The conventional unified pipeline is
 * `remark → remark-rehype → rehype-react`, and `remark-rehype` has a `allowDangerousHtml`
 * switch that a later maintainer will eventually be tempted by. Going straight from mdast
 * to React elements removes the temptation and the attack surface together: there is no
 * HTML string anywhere in this file, so "no raw-HTML passthrough in v1" (SPEC §8) is a
 * property of the architecture rather than a sanitizer configuration someone can loosen.
 * `html` nodes — which remark still produces, because the *syntax* is valid markdown —
 * are printed as text.
 *
 * **The four extension points, in the order they get a chance at a node:**
 *
 * 1. `markdown.component` — an override for this mdast node type wins outright.
 * 2. `markdown.directive` — `:::name` / `::name` / `:name[…]`, matched by kind + name.
 * 3. `markdown.fence` — a fenced block whose language is claimed.
 * 4. the built-in renderer.
 *
 * `markdown.remark` never appears here: it ran earlier, in `processor.ts`, and its effect
 * is whatever tree this function is handed.
 *
 * **Degrading to literal text is a feature** (SPEC §6.6: "Directives + fences are the
 * blessed syntaxes: named, collision-free, degrade to literal text when the plugin is
 * absent"). An unregistered directive is rendered from its own **source slice**, which is
 * the only faithful reconstruction available once remark has consumed the syntax.
 */

import { createElement, Fragment, type ComponentType, type ReactNode } from "react";

import type {
  MarkdownDirective,
  MarkdownDirectiveProps,
  MarkdownFenceProps,
} from "../../_shared/points.js";

import { AttachmentChip, AttachmentImage, DocLink } from "./links.js";
import { sourceOf, spanOf, textOf, walk, type MdNode } from "./mdast.js";
import type { MarkdownRuntime } from "./runtime.js";
import { classifyUrl, fragmentOf, idFromScheme } from "./schemes.js";
import { TaskCheckbox } from "./task-item.js";
import type { TaskRegistry, TaskScan } from "./tasks.js";

/** mdast node type → the `kind` a `markdown.directive` contribution declares. */
const DIRECTIVE_KINDS: Readonly<Record<string, MarkdownDirective["kind"]>> = {
  containerDirective: "container",
  leafDirective: "leaf",
  textDirective: "text",
};

/** The registries the renderer reads, resolved once per point revision. */
export interface RenderRegistries {
  readonly directives: ReadonlyMap<string, ComponentType<MarkdownDirectiveProps>>;
  readonly fences: ReadonlyMap<string, ComponentType<MarkdownFenceProps>>;
  readonly overrides: ReadonlyMap<string, ComponentType<Record<string, unknown>>>;
  readonly tasks: TaskRegistry;
}

export interface RenderOptions {
  readonly documentId: string | undefined;
  /** Absolute offset of `source[0]` in the document; `undefined` ⇒ "this is the body". */
  readonly offset: number | undefined;
  readonly registries: RenderRegistries;
  readonly runtime: MarkdownRuntime;
  /** Task markers located in `source`, plus the node → ordinal map. */
  readonly taskScan: TaskScan;
  /** Re-locate markers in a (possibly changed) body — the click path's recovery. */
  readonly rescan: (body: string) => TaskScan;
}

interface Env extends RenderOptions {
  readonly source: string;
  /** `definition` nodes by normalized identifier, for reference-style links. */
  readonly definitions: ReadonlyMap<string, MdNode>;
}

/** Render a parsed tree. The wrapper carries `.md-root`, the plugin's style hook. */
export function renderTree(tree: MdNode, source: string, options: RenderOptions): ReactNode {
  const definitions = new Map<string, MdNode>();
  walk(tree, (node) => {
    if (node.type === "definition" && typeof node.identifier === "string") {
      definitions.set(node.identifier.toLowerCase(), node);
    }
  });
  const env: Env = { ...options, source, definitions };
  return (
    <div className="md-root markdown:min-w-0 markdown:break-words markdown:font-sans markdown:leading-[1.6] markdown:text-text markdown:[--md-gutter:calc(var(--lm-space)*3)] markdown:[&>*+*]:mt-3 markdown:[&_:focus-visible]:outline-2 markdown:[&_:focus-visible]:outline-offset-2 markdown:[&_:focus-visible]:outline-focus markdown:[&_a]:break-words markdown:[&_a]:text-link markdown:[&_blockquote]:mx-0 markdown:[&_blockquote]:border-l-[3px] markdown:[&_blockquote]:border-border-strong markdown:[&_blockquote]:pl-4 markdown:[&_blockquote]:text-text-muted markdown:[&_h1]:my-2 markdown:[&_h1]:mt-6 markdown:[&_h1]:leading-tight markdown:[&_h2]:my-2 markdown:[&_h2]:mt-6 markdown:[&_h2]:leading-tight markdown:[&_h3]:my-2 markdown:[&_h3]:mt-6 markdown:[&_h3]:leading-tight markdown:[&_h4]:my-2 markdown:[&_h4]:mt-6 markdown:[&_h4]:leading-tight markdown:[&_h5]:my-2 markdown:[&_h5]:mt-6 markdown:[&_h5]:leading-tight markdown:[&_h6]:my-2 markdown:[&_h6]:mt-6 markdown:[&_h6]:leading-tight markdown:[&_hr]:border-0 markdown:[&_hr]:border-t markdown:[&_hr]:border-border markdown:[&_li>p]:my-0 markdown:[&_li>p+p]:mt-2">{renderChildren(tree, env)}</div>
  );
}

// ---------------------------------------------------------------------------
// the walk
// ---------------------------------------------------------------------------

function keyOf(node: MdNode, index: number): string {
  const span = spanOf(node);
  return span ? `${node.type}@${span.start}` : `${node.type}#${index}`;
}

function renderChildren(node: MdNode, env: Env): ReactNode[] {
  if (!node.children) return [];
  return node.children.map((child, index) => renderNode(child, keyOf(child, index), env));
}

function renderNode(node: MdNode, key: string, env: Env): ReactNode {
  const override = env.registries.overrides.get(node.type);
  if (override) {
    return createElement(override, {
      key,
      node,
      children: renderChildren(node, env),
      documentId: env.documentId,
    });
  }

  switch (node.type) {
    case "root":
      return <Fragment key={key}>{renderChildren(node, env)}</Fragment>;

    case "text":
      return <Fragment key={key}>{node.value ?? ""}</Fragment>;

    /**
     * Raw HTML, printed. SPEC §8 forbids passthrough; dropping it silently would lose
     * content the author typed, so it is shown as what it is.
     */
    case "html":
      return (
        <span key={key} className="md-raw-html markdown:border-b markdown:border-dashed markdown:border-border-strong markdown:font-mono markdown:text-[0.95em] markdown:text-text-muted" title="raw HTML is not rendered">
          {node.value ?? ""}
        </span>
      );

    case "paragraph":
      return <p key={key}>{renderChildren(node, env)}</p>;

    case "heading": {
      const depth = Math.min(Math.max(node.depth ?? 1, 1), 6);
      return createElement(
        `h${depth}`,
        { key, id: slug(textOf(node)) },
        ...renderChildren(node, env),
      );
    }

    case "strong":
      return <strong key={key}>{renderChildren(node, env)}</strong>;
    case "emphasis":
      return <em key={key}>{renderChildren(node, env)}</em>;
    case "delete":
      return <del key={key}>{renderChildren(node, env)}</del>;
    case "inlineCode":
      return (
        <code key={key} className="md-inline-code markdown:break-words markdown:rounded markdown:bg-bg-subtle markdown:px-[0.35em] markdown:py-[0.1em] markdown:font-mono markdown:text-[0.9em]">
          {node.value ?? ""}
        </code>
      );
    case "break":
      return <br key={key} />;
    case "thematicBreak":
      return <hr key={key} />;
    case "blockquote":
      return <blockquote key={key}>{renderChildren(node, env)}</blockquote>;

    case "list":
      return node.ordered === true ? (
        <ol key={key} start={node.start ?? undefined} className="md-list markdown:pl-[var(--md-gutter)]">
          {renderChildren(node, env)}
        </ol>
      ) : (
        <ul key={key} className="md-list markdown:pl-[var(--md-gutter)]">
          {renderChildren(node, env)}
        </ul>
      );

    case "listItem":
      return renderListItem(node, key, env);

    case "code":
      return renderCode(node, key, env);

    case "link":
      return renderLink(node, key, env);
    case "image":
      return renderImage(node, key, env);

    case "linkReference": {
      const resolved = resolveReference(node, env);
      return resolved
        ? renderLink({ ...node, url: resolved.url, title: resolved.title }, key, env)
        : renderLiteral(node, key, env, "inline");
    }
    case "imageReference": {
      const resolved = resolveReference(node, env);
      return resolved
        ? renderImage({ ...node, url: resolved.url, title: resolved.title }, key, env)
        : renderLiteral(node, key, env, "inline");
    }
    /** Definitions are metadata for the references above; they render nothing. */
    case "definition":
      return null;

    case "footnoteReference": {
      const id = node.identifier ?? "";
      return (
        <sup key={key} className="md-footnote-ref" id={`fnref-${slug(id)}`}>
          <a href={`#fn-${slug(id)}`}>{node.label ?? id}</a>
        </sup>
      );
    }
    case "footnoteDefinition": {
      const id = node.identifier ?? "";
      return (
        <div key={key} className="md-footnote" id={`fn-${slug(id)}`}>
          <span className="md-footnote-marker" aria-hidden="true">
            {node.label ?? id}
          </span>
          {renderChildren(node, env)}
        </div>
      );
    }

    case "table":
      return renderTable(node, key, env);

    case "containerDirective":
    case "leafDirective":
    case "textDirective":
      return renderDirective(node, key, env);

    default:
      // Anything a `markdown.remark` plugin invented. Children if it has them, its own
      // source if it does not — never silence.
      return node.children && node.children.length > 0 ? (
        <Fragment key={key}>{renderChildren(node, env)}</Fragment>
      ) : (
        renderLiteral(node, key, env, "inline")
      );
  }
}

// ---------------------------------------------------------------------------
// the interesting cases
// ---------------------------------------------------------------------------

/**
 * A list item, which is where the task registry lands.
 *
 * Three outcomes, and the middle one is the one SPEC §6.6 is explicit about:
 *
 * - no marker at this position ⇒ a plain `<li>`;
 * - a marker no `markdown.taskState` claims ⇒ **literal text**, re-inserting `[m] ` when
 *   `remark-gfm` had already eaten it (`[X]` is the case that does this);
 * - a registered marker ⇒ the checkbox, with `[m] ` removed from the text if GFM left it
 *   there (which it does for every marker outside its own three).
 */
function renderListItem(node: MdNode, key: string, env: Env): ReactNode {
  const ordinal = env.taskScan.ordinals.get(node);
  const location = ordinal === undefined ? undefined : env.taskScan.locations[ordinal];

  if (!location || ordinal === undefined) {
    return (
      <li key={key} className="md-item">
        {renderChildren(node, env)}
      </li>
    );
  }

  const state = env.registries.tasks.byMarker.get(location.marker);
  if (!state) {
    // Unregistered. GFM may already have eaten the marker (`[X]` is the case), in which case
    // it goes back **into the first text node** rather than in front of the item: a bare
    // string sibling of the item's paragraph would render the marker on its own line.
    const literal = location.consumedByGfm
      ? editFirstText(node, (value) => `[${location.marker}] ${value}`)
      : node;
    return (
      <li key={key} className="md-item">
        {renderChildren(literal, env)}
      </li>
    );
  }

  const body = location.consumedByGfm
    ? node
    : editFirstText(node, (value) =>
        value.startsWith(`[${location.marker}]`)
          ? value.slice(location.marker.length + 2).replace(/^[ \t]+/, "")
          : value,
      );
  return (
    <li key={key} className={`md-item md-task ${state.done === true ? " md-task-done" : ""} markdown:-ml-[var(--md-gutter)] markdown:flex markdown:list-none markdown:items-baseline markdown:gap-0 ${state.done === true ? " markdown:text-text-muted" : ""}`}>
      <TaskCheckbox
        state={state}
        registry={env.registries.tasks}
        location={location}
        ordinal={ordinal}
        documentId={env.documentId}
        offset={env.offset}
        runtime={env.runtime}
        rescan={env.rescan}
      />
      <span className="md-task-body">{renderChildren(body, env)}</span>
    </li>
  );
}

/**
 * Rewrite the **first text descendant** of a node, returning a new tree.
 *
 * Both halves of the task-marker fix-up go through here, in opposite directions:
 *
 * - a *registered* marker GFM did not recognise is still literally in the text (`[/] write
 *   the spec`), so it is removed — otherwise the document reads `[/] [/] write the spec`;
 * - an *unregistered* marker GFM did recognise is gone from the text (`[X]`), so it is put
 *   back, inside the text rather than beside it.
 *
 * Only the spine down to that text node is shallow-cloned, so every other node keeps its
 * identity — which matters, because `TaskScan.ordinals` is keyed on it.
 */
function editFirstText(node: MdNode, rewrite: (value: string) => string): MdNode {
  let done = false;

  const visit = (current: MdNode): MdNode => {
    if (done) return current;
    if (typeof current.value === "string") {
      const next = rewrite(current.value);
      if (next === current.value) return current;
      done = true;
      return { ...current, value: next };
    }
    if (!current.children || current.children.length === 0) return current;
    const children = [...current.children];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (!child) continue;
      const replacement = visit(child);
      if (replacement !== child) {
        children[index] = replacement;
        return { ...current, children };
      }
      if (done) break;
    }
    return current;
  };

  return visit(node);
}

/** A fenced code block: a contributed `markdown.fence` renderer, or a `<pre>`. */
function renderCode(node: MdNode, key: string, env: Env): ReactNode {
  const language = (node.lang ?? "").trim();
  const fence = env.registries.fences.get(language) ?? env.registries.fences.get(language.toLowerCase());
  if (fence) {
    return createElement(fence, {
      key,
      code: node.value ?? "",
      meta: node.meta ?? undefined,
      documentId: env.documentId,
    });
  }
  return (
    <pre key={key} className="md-code markdown:overflow-x-auto markdown:rounded markdown:border markdown:border-border markdown:bg-bg-subtle markdown:p-3 markdown:font-mono">
      <code className={language ? `language-${language}` : undefined}>{node.value ?? ""}</code>
    </pre>
  );
}

/**
 * A link. `doc://` and `attachment://` get their own renderers; `http`/`https`/`mailto`
 * become an `<a>`; a bare `#fragment` becomes an in-page anchor; **everything else renders
 * as the literal markdown the author typed** (SPEC §8).
 */
function renderLink(node: MdNode, key: string, env: Env): ReactNode {
  const verdict = classifyUrl(node.url);
  if (verdict.kind === "blocked") {
    env.runtime.kernel.log.debug("link destination blocked", { url: node.url, reason: verdict.reason });
    return renderLiteral(node, key, env, "inline", `blocked: ${verdict.reason}`);
  }

  if (verdict.kind === "fragment") {
    return (
      <a key={key} className="md-anchor" href={verdict.url}>
        {renderChildren(node, env)}
      </a>
    );
  }

  const documentTarget = idFromScheme(node.url, "doc");
  if (documentTarget !== null) {
    const children = renderChildren(node, env);
    const label = textOf(node).trim().length > 0 ? children : undefined;
    return (
      <DocLink
        key={key}
        id={documentTarget}
        label={label}
        fragment={fragmentOf(node.url)}
        runtime={env.runtime}
      />
    );
  }

  const attachment = idFromScheme(node.url, "attachment");
  if (attachment !== null) {
    return <AttachmentChip key={key} id={attachment} alt={textOf(node)} runtime={env.runtime} />;
  }

  return (
    <a
      key={key}
      className="md-link markdown:break-words markdown:text-link"
      href={verdict.url}
      title={node.title ?? undefined}
      // External destinations only, so `noopener`/`noreferrer` costs nothing and closes
      // reverse-tabnabbing on every one of them.
      target={verdict.scheme === "mailto" ? undefined : "_blank"}
      rel="noopener noreferrer"
    >
      {renderChildren(node, env)}
    </a>
  );
}

/** An image. `attachment://` is the app's own scheme; `http(s)` is an ordinary `<img>`. */
function renderImage(node: MdNode, key: string, env: Env): ReactNode {
  const verdict = classifyUrl(node.url);
  if (verdict.kind !== "allowed") {
    env.runtime.kernel.log.debug("image source blocked", {
      url: node.url,
      reason: verdict.kind === "blocked" ? verdict.reason : "fragment is not an image source",
    });
    return renderLiteral(node, key, env, "inline", "blocked image source");
  }

  const attachment = idFromScheme(node.url, "attachment");
  if (attachment !== null) {
    return (
      <AttachmentImage key={key} id={attachment} alt={node.alt ?? undefined} runtime={env.runtime} />
    );
  }

  // A `doc://` image has no bytes behind it; render the link instead of a broken frame.
  const documentTarget = idFromScheme(node.url, "doc");
  if (documentTarget !== null) {
    return <DocLink key={key} id={documentTarget} runtime={env.runtime} />;
  }

  if (verdict.scheme === "mailto") return renderLiteral(node, key, env, "inline", "blocked image source");

  return (
    <img
      key={key}
      className="markdown:max-w-full markdown:rounded"
      src={verdict.url}
      alt={node.alt ?? ""}
      title={node.title ?? undefined}
      loading="lazy"
    />
  );
}

/** A GFM table. `align` is per-column and applies to every cell in it. */
function renderTable(node: MdNode, key: string, env: Env): ReactNode {
  const align = node.align ?? [];
  const rows = node.children ?? [];
  const [head, ...body] = rows;

  const cells = (row: MdNode, tag: "th" | "td"): ReactNode[] =>
    (row.children ?? []).map((cell, column) =>
      createElement(
        tag,
        {
          key: keyOf(cell, column),
          style: align[column] ? { textAlign: align[column] as "left" | "right" | "center" } : undefined,
          scope: tag === "th" ? "col" : undefined,
        },
        ...renderChildren(cell, env),
      ),
    );

  return (
    <div key={key} className="md-table-scroll markdown:overflow-x-auto">
      <table className="md-table markdown:min-w-full markdown:border-collapse markdown:[&_td]:border markdown:[&_td]:border-border markdown:[&_td]:px-2 markdown:[&_td]:py-1.5 markdown:[&_th]:border markdown:[&_th]:border-border markdown:[&_th]:bg-bg-subtle markdown:[&_th]:px-2 markdown:[&_th]:py-1.5">
        {head ? (
          <thead>
            <tr>{cells(head, "th")}</tr>
          </thead>
        ) : null}
        <tbody>
          {body.map((row, index) => (
            <tr key={keyOf(row, index)}>{cells(row, "td")}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A directive. Registered ⇒ the contributed component; unregistered ⇒ literal source.
 *
 * The label is separated from the content because the point's props type says so: a
 * container directive's `[label]` arrives as a first paragraph flagged
 * `data.directiveLabel`, and passing it twice (once as `label`, once inside `children`)
 * would make every contributed component render its own title twice.
 */
function renderDirective(node: MdNode, key: string, env: Env): ReactNode {
  const kind = DIRECTIVE_KINDS[node.type];
  const name = node.name ?? "";
  const component = kind ? env.registries.directives.get(`${kind}:${name}`) : undefined;

  if (!component) {
    return renderLiteral(node, key, env, kind === "text" ? "inline" : "block", `no renderer for :${name}`);
  }

  const labelNode =
    kind === "container" ? node.children?.find((child) => child.data?.directiveLabel === true) : undefined;
  const content: MdNode =
    labelNode === undefined
      ? node
      : { ...node, children: (node.children ?? []).filter((child) => child !== labelNode) };
  const label = labelNode ? textOf(labelNode) : kind === "container" ? undefined : textOf(node);

  return createElement(component, {
    key,
    attributes: normalizeAttributes(node.attributes),
    label,
    // A text/leaf directive's children *are* its label; a container's are its body.
    children: kind === "container" ? renderChildren(content, env) : renderChildren(node, env),
    documentId: env.documentId,
  });
}

/** `attributes` with nulls dropped — the point's props promise `Record<string, string>`. */
function normalizeAttributes(
  attributes: MdNode["attributes"],
): Readonly<Record<string, string>> {
  if (!attributes) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/**
 * Render a node as the literal markdown it came from.
 *
 * This is the degradation path SPEC §6.6 promises for an absent syntax plugin, and the
 * fallback for a destination the allowlist refused. `title` explains *why* in a tooltip;
 * it is never put in the DOM as markup.
 */
function renderLiteral(
  node: MdNode,
  key: string,
  env: Env,
  layout: "inline" | "block",
  reason?: string,
): ReactNode {
  const literal = sourceOf(node, env.source) ?? textOf(node);
  const className = layout === "block"
    ? "md-literal md-literal-block markdown:block markdown:overflow-x-auto markdown:whitespace-pre-wrap markdown:rounded markdown:border markdown:border-dashed markdown:border-border-strong markdown:p-2 markdown:font-mono markdown:text-[0.95em] markdown:text-text-muted"
    : "md-literal markdown:border-b markdown:border-dashed markdown:border-border-strong markdown:font-mono markdown:text-[0.95em] markdown:text-text-muted";
  return layout === "block" ? (
    <div key={key} className={className} title={reason}>
      {literal}
    </div>
  ) : (
    <span key={key} className={className} title={reason}>
      {literal}
    </span>
  );
}

/** A heading/footnote anchor id. ASCII-safe, collision-tolerant, never empty. */
function slug(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "section";
}

/** Resolve a `linkReference`/`imageReference` against the document's definitions. */
function resolveReference(
  node: MdNode,
  env: Env,
): { url: string | undefined; title: string | null | undefined } | undefined {
  const identifier = node.identifier;
  if (typeof identifier !== "string") return undefined;
  const definition = env.definitions.get(identifier.toLowerCase());
  return definition ? { url: definition.url, title: definition.title } : undefined;
}
