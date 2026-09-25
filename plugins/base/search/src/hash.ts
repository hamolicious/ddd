/**
 * The search query lives in the URL.
 *
 * `router.route` patterns match `:name` *path* segments (`_shared/points.ts`), so a
 * query string is not something the router hands back — and a search result page that
 * cannot be linked to, or that loses the query on reload, is a worse answer than
 * parsing five characters here. `#/search?q=milk` is the canonical spelling.
 */

/** Read one query parameter out of a hash route. */
export function queryParam(hash: string, name: string): string {
  const path = hash.replace(/^#/, "");
  const index = path.indexOf("?");
  if (index === -1) return "";
  return new URLSearchParams(path.slice(index + 1)).get(name) ?? "";
}

/** The hash path for a search. Empty query ⇒ the bare results page. */
export function searchPath(query: string): string {
  const trimmed = query.trim();
  return trimmed === "" ? "/search" : `/search?q=${encodeURIComponent(trimmed)}`;
}

/**
 * The hash path for one result, deep-linked to the line the snippet came from.
 *
 * `?line=` is `document-surface`'s query (`LINE_PARAM` there), and it is spelled here
 * as a literal rather than imported: `search` does not depend on `document-surface` in
 * its manifest, and a plugin must never import another plugin's source (`web/README.md`
 * — interaction goes through the registry, or through an address both sides agree on).
 * A URL is exactly that kind of agreed address, and the surface ignores a `line` it
 * cannot use, so the failure mode of a disagreement is a document that opens at the top.
 */
export function documentPath(id: string, line?: number): string {
  const path = `/doc/${encodeURIComponent(id)}`;
  return line !== undefined && Number.isSafeInteger(line) && line >= 1
    ? `${path}?line=${String(line)}`
    : path;
}
