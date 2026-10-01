/**
 * Compile-time proof that the frozen `@kernel` contract and the M2 substrate have
 * not drifted apart.
 *
 * `kernel-api/` declares its own `DocumentRow`, `SyncStatus`, `SortKey` and friends
 * rather than re-exporting the internal ones, for a good reason: `/kernel.d.ts` has
 * to stand alone, and a public contract that imports from `kernel/src/protocol.ts`
 * would drag the whole internal tree into it. The cost is two declarations of one
 * shape — and this file is the interest payment. Change either side without the
 * other and `npm run typecheck` fails here, loudly, naming the type.
 *
 * Nothing imports this module; it exists to be type-checked.
 */

import type {
  DocumentQuery,
  DocumentQueryResult,
  DocumentRow,
  OpenDocument,
  PlanHit,
  PlanResult,
  QueryPlan,
  SearchHit,
  SearchOptions,
  SortDirection,
  SortKey,
  SyncStatus,
} from "@kernel";

import type { ProjectionRow } from "../protocol.js";
import type { Query, QueryResult, SortKey as InternalSortKey, SortDirection as InternalSortDirection } from "../query/filter.js";
import type { SearchHit as InternalSearchHit, SearchOptions as InternalSearchOptions } from "../query/search.js";
import type { PlanResult as InternalPlanResult } from "../query/index.js";
import type { PlanHit as InternalPlanHit, QueryPlan as InternalQueryPlan } from "../query/plan.js";
import type { SyncStatus as InternalSyncStatus } from "../sync/feed-client.js";
import type { HydratedDoc } from "../sync/doc-hydration.js";

/** `A` must be assignable to `B` *and* back: identical, not merely compatible. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** Each line is a proof obligation; a drift turns the `true` into `never`. */
export type ContractParity = {
  readonly documentRow: Same<DocumentRow, ProjectionRow>;
  readonly sortKey: Same<SortKey, InternalSortKey>;
  readonly sortDirection: Same<SortDirection, InternalSortDirection>;
  readonly syncStatus: Same<SyncStatus, InternalSyncStatus>;
  readonly searchHit: Same<SearchHit, InternalSearchHit>;
  readonly queryPlan: Same<QueryPlan, InternalQueryPlan>;
  readonly planHit: Same<PlanHit, InternalPlanHit>;
  readonly planResult: Same<PlanResult, InternalPlanResult>;
};

const _parity: ContractParity = {
  documentRow: true,
  sortKey: true,
  sortDirection: true,
  syncStatus: true,
  searchHit: true,
  queryPlan: true,
  planHit: true,
  planResult: true,
};
void _parity;

/**
 * One-way obligations: the internal type may carry *more* than the contract
 * promises (the query engine's `Query` has no extra fields today, but adding one
 * must not be a breaking change), so these assert assignability in the direction
 * the runtime actually relies on.
 */
const _queryIsAcceptable: Query = {} as DocumentQuery;
const _resultIsReturnable: DocumentQueryResult = {} as QueryResult;
const _searchOptionsAreAcceptable: InternalSearchOptions = {} as SearchOptions;
const _hydratedIsOpenDocument: OpenDocument = {} as HydratedDoc;
void _queryIsAcceptable;
void _resultIsReturnable;
void _searchOptionsAreAcceptable;
void _hydratedIsOpenDocument;
