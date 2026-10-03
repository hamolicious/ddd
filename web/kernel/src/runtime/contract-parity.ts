import type { DocumentRow, OpenDocument, SyncStatus } from "@kernel";

import type { ProjectionRow } from "../protocol.js";
import type { SyncStatus as InternalSyncStatus } from "../sync/feed-client.js";
import type { HydratedDoc } from "../sync/doc-hydration.js";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export type ContractParity = {
  readonly documentRow: Same<DocumentRow, ProjectionRow>;
  readonly syncStatus: Same<SyncStatus, InternalSyncStatus>;
};

const _parity: ContractParity = {
  documentRow: true,
  syncStatus: true,
};
void _parity;

const _hydratedIsOpenDocument: OpenDocument = {} as HydratedDoc;
void _hydratedIsOpenDocument;
