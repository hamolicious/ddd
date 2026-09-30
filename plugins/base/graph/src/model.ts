/**
 * What the graph shows: nodes and links, read from `indexer`, filtered. Pure.
 *
 * A node is a live document, or — with `showMissing` — a `doc://` id that some note links
 * to and this device does not know (Obsidian's "unresolved" notes). Links come from each
 * document's **outgoing** connections only: an incoming connection is the same edge seen
 * from the other end, and reading both would draw it twice. Trashed targets are left out,
 * as the indexer leaves them out of backlinks.
 *
 * A link is directed and drawn once per (source, target), whatever mix of kinds makes it
 * up; `weight` is how many references it stands for.
 */

import type { DocumentId } from "@kernel";

import type { ConnectionKind, WorkspaceIndex } from "plugin:indexer";

export interface GraphNode {
  readonly id: DocumentId;
  readonly title: string;
  readonly folder: string;
  /** No such document on this device: a link points at it and nothing more. */
  readonly missing: boolean;
  /** Links to and from it, in the filtered graph — the whole of it, even in a local graph that shows fewer. */
  readonly degree: number;
}

export interface GraphLink {
  readonly source: DocumentId;
  readonly target: DocumentId;
  readonly kinds: readonly ConnectionKind[];
  readonly weight: number;
}

export interface Graph {
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLink[];
}

export interface GraphFilter {
  /** Keep notes whose title or folder contains this, case-insensitively. Empty keeps all. */
  readonly search: string;
  /** Keep notes with no link to or from another shown note. */
  readonly showOrphans: boolean;
  /** Show link targets this device does not know. */
  readonly showMissing: boolean;
  readonly showEmbeds: boolean;
  readonly showFrontmatter: boolean;
}

export const DEFAULT_FILTER: GraphFilter = {
  search: "",
  showOrphans: true,
  showMissing: false,
  showEmbeds: true,
  showFrontmatter: true,
};

/** The two things the model reads from the indexer. */
export type GraphSource = Pick<WorkspaceIndex, "documents" | "connections">;

export function buildGraph(source: GraphSource, filter: GraphFilter = DEFAULT_FILTER): Graph {
  const documents = source.documents();
  const known = new Map(documents.map((document) => [document.id, document]));
  const needle = filter.search.trim().toLowerCase();
  const matches = (title: string, folder: string): boolean =>
    !needle || title.toLowerCase().includes(needle) || folder.toLowerCase().includes(needle);

  const shown = new Set<DocumentId>();
  for (const document of documents) if (matches(document.title, document.folder)) shown.add(document.id);

  const links = new Map<string, { source: DocumentId; target: DocumentId; kinds: Set<ConnectionKind>; weight: number }>();
  const missing = new Set<DocumentId>();
  for (const document of documents) {
    if (!shown.has(document.id)) continue;
    for (const connection of source.connections(document.id).outgoing) {
      if (connection.kind === "embed" && !filter.showEmbeds) continue;
      if (connection.kind === "frontmatter" && !filter.showFrontmatter) continue;
      if (connection.state === "trashed") continue;
      if (connection.state === "missing") {
        // A missing note has no title to search; it follows the notes that link to it.
        if (!filter.showMissing) continue;
        missing.add(connection.id);
      } else if (!shown.has(connection.id)) {
        continue;
      }
      const key = `${document.id}\u0000${connection.id}`;
      let link = links.get(key);
      if (!link) {
        link = { source: document.id, target: connection.id, kinds: new Set(), weight: 0 };
        links.set(key, link);
      }
      link.kinds.add(connection.kind);
      link.weight += connection.count;
    }
  }

  const degree = new Map<DocumentId, number>();
  for (const link of links.values()) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }

  const nodes: GraphNode[] = [];
  for (const id of shown) {
    const document = known.get(id)!;
    const count = degree.get(id) ?? 0;
    if (count === 0 && !filter.showOrphans) continue;
    nodes.push({ id, title: document.title, folder: document.folder, missing: false, degree: count });
  }
  for (const id of missing) {
    nodes.push({ id, title: id, folder: "", missing: true, degree: degree.get(id) ?? 0 });
  }

  return {
    nodes,
    links: [...links.values()].map(({ source, target, kinds, weight }) => ({
      source,
      target,
      kinds: [...kinds],
      weight,
    })),
  };
}

/**
 * The part of `graph` within `depth` links of `center`, following links both ways — the
 * local graph. `center` is always in it, even with no links and even when a filter would
 * have hidden it. Each node keeps its degree from `graph`: a note at the edge of the
 * neighbourhood is drawn as big as it is, not as big as the part of it that is shown.
 */
export function neighbourhood(graph: Graph, center: DocumentId, depth: number, source?: GraphSource): Graph {
  const adjacent = new Map<DocumentId, DocumentId[]>();
  const add = (from: DocumentId, to: DocumentId): void => {
    const list = adjacent.get(from);
    if (list) list.push(to);
    else adjacent.set(from, [to]);
  };
  for (const link of graph.links) {
    add(link.source, link.target);
    add(link.target, link.source);
  }

  const reached = new Set<DocumentId>([center]);
  let frontier: DocumentId[] = [center];
  for (let step = 0; step < depth && frontier.length > 0; step += 1) {
    const next: DocumentId[] = [];
    for (const id of frontier) {
      for (const other of adjacent.get(id) ?? []) {
        if (reached.has(other)) continue;
        reached.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }

  const links = graph.links.filter((link) => reached.has(link.source) && reached.has(link.target));
  const nodes = graph.nodes.filter((node) => reached.has(node.id));
  if (!nodes.some((node) => node.id === center)) {
    const document = source?.documents().find((candidate) => candidate.id === center);
    nodes.push({ id: center, title: document?.title ?? center, folder: document?.folder ?? "", missing: false, degree: 0 });
  }
  return { nodes, links };
}

/** A key that changes when the set of nodes or links does — not when a title does. */
export function shapeKey(graph: Graph): string {
  const nodes = graph.nodes.map((node) => node.id).sort();
  const links = graph.links.map((link) => `${link.source}>${link.target}`).sort();
  return `${nodes.join(",")}|${links.join(",")}`;
}

/** The top-level folder, which is what "colour by folder" groups on. */
export function groupOf(node: GraphNode): string {
  return node.folder.split(" / ")[0] ?? "";
}
