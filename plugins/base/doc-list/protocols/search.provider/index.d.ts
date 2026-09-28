/**
 * lm/search.provider@1.0.0: slot, owned by `doc-list`.
 *
 * A search backend. The default is the local index; the server is a fallback, and a plugin
 * may add its own (a semantic index, an external wiki). Providers run in seat order.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { SearchHit } from "@kernel";

/** The protocol this package describes. */
export type ProtocolId = "lm/search.provider";
export type ProtocolVersion = "1.0.0";

export interface SearchProvider {
  readonly id: string;
  readonly label: string;
  /** Default-seat hint only; the local index is 0. */
  readonly order?: number;
  readonly search: (query: string, options: { readonly limit?: number; readonly includeDeleted?: boolean }) => Promise<readonly SearchHit[]>;
}
