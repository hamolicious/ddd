import type { BootMode } from "@kernel";

export type SafeMode = "off" | "base" | "bare";

export function safeModeFrom(search: string): SafeMode {
  const value = new URLSearchParams(search).get("safe");
  if (value === null) return "off";
  if (value === "bare") return "bare";
  return value === "0" || value === "false" ? "off" : "base";
}

export const bootModeFor = (mode: SafeMode): BootMode =>
  mode === "off" ? "normal" : mode === "base" ? "safe" : "bare";

export function safeModeUrl(mode: SafeMode): string {
  const url = new URL(globalThis.location?.href ?? "http://localhost/");
  url.hash = "";
  if (mode === "off") url.searchParams.delete("safe");
  else url.searchParams.set("safe", mode === "bare" ? "bare" : "1");
  return url.href;
}
