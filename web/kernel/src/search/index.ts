export { ProjectionHost, type ProjectionBackend, type ProjectionHostOptions } from "./backend.js";
export {
  SEARCH_DB_FILE,
  SEARCH_OPFS_DIRECTORY,
  openSearchDatabase,
  markSearchWipePending,
  removeSearchFiles,
  searchWipePending,
  type SearchDatabase,
  type SqlRow,
} from "./database.js";
export { coreSqlFunctions, type SqlFunction } from "./functions.js";
export { PROJECTION_CHUNK, ProjectionFeed, type ProjectionProgress, type ProjectionRole } from "./feed.js";
export { SearchHost } from "./host.js";
export { SEARCH_CHANNEL, SEARCH_LOCK, browserPeers, type PeerMessage, type PeerOp, type SearchPeers } from "./peers.js";
export { planError, serializeSearchError, type SerializedSearchError } from "./errors.js";
export { reviveSearchError } from "./revive.js";
export {
  SearchProjection,
  stampOf,
  type ProjectionStatus,
  type ProjectionSync,
  type SearchRows,
} from "./projection.js";

