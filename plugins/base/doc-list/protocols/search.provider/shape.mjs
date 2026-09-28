import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/search.provider",
  version: "1.0.0",
  kind: "slot",
  name: "SearchProvider",
  key: "id",
  description: `
A search backend. The default is the local index; the server is a fallback, and a plugin may
add its own (a semantic index, an external wiki). Providers run in seat order.`,
  imports: `import type { SearchHit } from "@kernel";`,
  shape: s.object({
    id: s.string(),
    label: s.string(),
    order: s.optional(s.number()).describe("Default-seat hint only; the local index is 0."),
    search: s
      .func()
      .as("(query: string, options: { readonly limit?: number; readonly includeDeleted?: boolean }) => Promise<readonly SearchHit[]>"),
  }),
};
