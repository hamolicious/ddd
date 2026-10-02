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

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

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

const _queryIsAcceptable: Query = {} as DocumentQuery;
const _resultIsReturnable: DocumentQueryResult = {} as QueryResult;
const _searchOptionsAreAcceptable: InternalSearchOptions = {} as SearchOptions;
const _hydratedIsOpenDocument: OpenDocument = {} as HydratedDoc;
void _queryIsAcceptable;
void _resultIsReturnable;
void _searchOptionsAreAcceptable;
void _hydratedIsOpenDocument;
