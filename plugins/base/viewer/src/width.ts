import type { CoreValue } from "@kernel";

export const FULL_WIDTH_KEY = "full-width";

export function isFullWidth(fm: Readonly<Record<string, CoreValue>> | undefined): boolean {
  return fm?.[FULL_WIDTH_KEY] === true;
}

export function columnClasses(fullWidth: boolean): string {
  return fullWidth ? "viewer:max-w-none viewer:px-[15px]" : "viewer:max-w-[72ch] viewer:px-4";
}
