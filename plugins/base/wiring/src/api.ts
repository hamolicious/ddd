/**
 * The typed client over the wiring routes (PLUGIN-PROTOCOLS §7). The server authorizes:
 * every route here is admin-only and answers 403 to anyone else, so the plugin hides its
 * entry points for non-admins as a courtesy and never as a security measure.
 *
 * ```
 * GET  /api/plugins                 the plugin list, with the live wiring, protocols and resolutions
 * GET  /api/wiring                  { live, history }   history newest first
 * GET  /api/wiring/versions/{v}     one stored version
 * POST /api/wiring/apply            { base, wiring, action } → { live } | 409 when `base` is stale
 * ```
 */

import type { InstalledPlugin, LiveWiring, ProtocolPackage, ResolvedPluginSet, WiringOverrides } from "@kernel";

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface PluginList {
  readonly plugins: readonly InstalledPlugin[];
  readonly wiring?: LiveWiring;
  readonly protocols?: readonly ProtocolPackage[];
  readonly resolved?: ResolvedPluginSet;
}

export interface WiringVersionInfo {
  readonly version: number;
  readonly action: string;
  readonly actor?: string;
  readonly subject?: string;
  /** RFC 3339. */
  readonly at: string;
}

export interface WiringState {
  readonly live: LiveWiring;
  readonly history: readonly WiringVersionInfo[];
}

export interface WiringVersion extends WiringVersionInfo {
  readonly wiring: WiringOverrides;
}

export type ApplyAction = "apply" | "rollback";

export interface ApplyRequest {
  readonly base: number;
  readonly wiring: WiringOverrides;
  readonly action: ApplyAction;
}

export type ApplyResult = { readonly kind: "applied"; readonly live: LiveWiring } | { readonly kind: "stale" };

export interface WiringClient {
  plugins(): Promise<PluginList>;
  wiring(): Promise<WiringState>;
  version(v: number): Promise<WiringVersion>;
  apply(request: ApplyRequest): Promise<ApplyResult>;
}

/** An error `kernel.session.fetch` rejected with: the server's sentence plus its status. */
export const statusOf = (error: unknown): number | undefined =>
  typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;

export function createWiringClient(fetchApi: ApiFetch): WiringClient {
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchApi(path, init);
    return (await response.json()) as T;
  };
  return {
    plugins: () => json<PluginList>("/plugins"),
    wiring: () => json<WiringState>("/wiring"),
    version: (v) => json<WiringVersion>(`/wiring/versions/${encodeURIComponent(String(v))}`),
    apply: async (request) => {
      try {
        const { live } = await json<{ live: LiveWiring }>("/wiring/apply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        return { kind: "applied", live };
      } catch (error) {
        if (statusOf(error) === 409) return { kind: "stale" };
        throw error;
      }
    },
  };
}

/** `2026-09-28T10:00:00Z` → a short local time for the history list. */
export function formatWhen(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}
