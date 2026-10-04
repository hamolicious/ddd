export const ADVANCED_PARAM = "advanced";

export function isAdvanced(query: string): boolean {
  return [...new URLSearchParams(query).keys()].some((key) => key !== "q");
}

export function basicPath(query: string): string {
  const text = query.trim();
  return text === "" ? "/" : `/?${new URLSearchParams({ q: text }).toString()}`;
}
