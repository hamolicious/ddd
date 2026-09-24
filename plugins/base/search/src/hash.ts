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
