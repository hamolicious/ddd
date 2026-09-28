/**
 * The `/api/sync` wire protocol, in TypeScript.
 *
 * **This file mirrors `backend/PROTOCOL.md` and nothing else.** It is the one
 * place in the client that knows the wire format; every other kernel module
 * imports its types from here. When the protocol document changes, this file
 * changes in the same commit — and where the two disagree, the document wins.
 *
 * Only the framing helpers (`encodeFrame` / `decodeFrame`) and the type guards
 * are implemented here: they are pure, tiny, and both the demo and the
 * convergence harness need them to be exactly right.
 */

/** Protocol version — the `protocol` field of `welcome`. */
export const PROTOCOL_VERSION = 1;

/** The subprotocol every client must offer. */
export const SUBPROTOCOL = `life-manager.v${PROTOCOL_VERSION}`;

/**
 * Bearer-token subprotocol prefix (native shells and tests — PROTOCOL.md §1.1).
 * The raw session token is appended verbatim.
 */
export const BEARER_SUBPROTOCOL_PREFIX = "life-manager.bearer.";

/** Hard frame ceiling, both directions (SPEC §4.3). */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** Default catch-up page size requested by `feed.subscribe`. */
export const DEFAULT_BATCH_MAX_ROWS = 200;

/** Default page size for `GET /api/sync/bootstrap`. */
export const DEFAULT_BOOTSTRAP_LIMIT = 200;

/** Sequence number of "I have nothing". */
export const FEED_SEQ_NONE = 0;

// ---------------------------------------------------------------------------
// Binary frames (PROTOCOL.md §3.1)
// ---------------------------------------------------------------------------

export const FrameType = {
  SyncStep1: 0x01,
  SyncStep2: 0x02,
  Update: 0x03,
  Awareness: 0x04,
  AwarenessQuery: 0x05,
  /**
   * An edit made while offline, with when it was made: 8 bytes of big-endian epoch
   * milliseconds, then a Yjs update (encoding v1). Client → server, sent on reconnect
   * before the state-vector exchange (PROTOCOL.md §3.7).
   */
  History: 0x06,
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

/** Frame types at or above this are reserved for M4 plugin channels; ignore unknown ones. */
export const RESERVED_FRAME_TYPE_FLOOR = 0x10;

export interface BinaryFrame {
  readonly type: number;
  /** Document id (ULID). */
  readonly docId: string;
  /** Opaque y-protocols payload. Never inspected by the transport. */
  readonly payload: Uint8Array;
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly closeCode: number = CloseCode.ProtocolError,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Encode one binary frame: `[type][idLen][id][payload]`. */
export function encodeFrame(frame: BinaryFrame): Uint8Array {
  const id = new TextEncoder().encode(frame.docId);
  if (id.length === 0 || id.length > 255) {
    throw new ProtocolError(`document id must be 1..255 bytes, got ${id.length}`);
  }
  const out = new Uint8Array(2 + id.length + frame.payload.length);
  out[0] = frame.type;
  out[1] = id.length;
  out.set(id, 2);
  out.set(frame.payload, 2 + id.length);
  if (out.length > MAX_FRAME_BYTES) {
    throw new ProtocolError(
      `frame of ${out.length} bytes exceeds MAX_FRAME_BYTES`,
      CloseCode.FrameTooLarge,
    );
  }
  return out;
}

/** Decode one binary frame. Throws `ProtocolError` on anything malformed. */
export function decodeFrame(data: ArrayBuffer | Uint8Array): BinaryFrame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 3) {
    throw new ProtocolError(`binary frame of ${bytes.length} bytes is too short`);
  }
  const type = bytes[0] as number;
  const idLen = bytes[1] as number;
  if (idLen === 0 || bytes.length < 2 + idLen) {
    throw new ProtocolError(`binary frame declares a ${idLen}-byte id it does not carry`);
  }
  const docId = new TextDecoder().decode(bytes.subarray(2, 2 + idLen));
  return { type, docId, payload: bytes.subarray(2 + idLen) };
}

// ---------------------------------------------------------------------------
// Close codes (PROTOCOL.md §7)
// ---------------------------------------------------------------------------

export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  ProtocolError: 4400,
  Unauthenticated: 4401,
  OriginRefused: 4403,
  Flood: 4408,
  UnsupportedVersion: 4409,
  FrameTooLarge: 4413,
  TooManySockets: 4429,
  ShuttingDown: 4503,
} as const;

export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/** Codes that must stop the reconnect loop until a user action (PROTOCOL.md §8). */
export const TERMINAL_CLOSE_CODES: readonly number[] = [
  CloseCode.Unauthenticated,
  CloseCode.OriginRefused,
  CloseCode.UnsupportedVersion,
];

// ---------------------------------------------------------------------------
// Shared value shapes
// ---------------------------------------------------------------------------

/** RFC 3339 / ISO-8601 UTC with millisecond precision. Never extended JSON. */
export type Iso8601 = string;

/** A value from the shared-core value model (SPEC §3.4). */
export type CoreValue =
  | null
  | boolean
  | number
  | string
  | readonly CoreValue[]
  | { readonly [key: string]: CoreValue };

export type CoreMap = { readonly [key: string]: CoreValue };

/**
 * The replicated projection of one document (SPEC §4.1, PROTOCOL.md §2.1).
 * `content` is absent when the subscription asked for metadata only, and when
 * the row is a purge notice.
 */
export interface ProjectionRow {
  readonly id: string;
  readonly title: string;
  readonly content?: string;
  readonly fm: CoreMap;
  readonly plugins: CoreMap;
  readonly fm_parse_error: boolean;
  readonly materialized_version: string;
  readonly created_at: Iso8601;
  readonly created_by: string | null;
  readonly updated_at: Iso8601;
  readonly updated_by: string | null;
  readonly deleted: boolean;
  readonly deleted_at: Iso8601 | null;
  readonly deleted_by: string | null;
  /** `true` ⇒ permanently purged: drop the local row and any local replica. */
  readonly purged: boolean;
}

/** A projection row as it travels in the feed: with its sequence number. */
export interface FeedRow extends ProjectionRow {
  readonly seq: number;
}

// ---------------------------------------------------------------------------
// Server → client control messages (PROTOCOL.md §9)
// ---------------------------------------------------------------------------

export interface SessionInfo {
  readonly user_id: string;
  readonly is_admin: boolean;
  readonly via: "cookie" | "bearer";
  readonly expires_at: Iso8601;
}

export interface FeedPosition {
  readonly head_seq: number;
  readonly safe_seq: number;
  readonly floor_seq: number;
}

export interface ConnectionLimits {
  readonly max_frame_bytes: number;
  readonly max_subscriptions: number;
  readonly feed_catchup_max_rows: number;
  readonly inbound_frames_per_sec: number;
  readonly inbound_bytes_per_sec: number;
  readonly heartbeat_secs: number;
}

export interface Welcome {
  readonly t: "welcome";
  readonly protocol: number;
  readonly server_time: Iso8601;
  readonly session: SessionInfo;
  readonly feed: FeedPosition;
  readonly limits: ConnectionLimits;
  readonly core_semantics_version: number;
  /**
   * The live wiring version (PLUGIN-PROTOCOLS §6c). A client that was offline while the
   * wiring changed compares it with the version it runs. Absent on older servers.
   */
  readonly wiring_version?: number;
}

/**
 * The plugin wiring moved to `version` (PLUGIN-PROTOCOLS §6c). Sent to every connected
 * session; a dropped one is recovered from `welcome.wiring_version` on reconnect.
 */
export interface WiringApplied {
  readonly t: "wiring.applied";
  readonly version: number;
  readonly action: string;
  readonly at: Iso8601;
}

export interface FeedBatch {
  readonly t: "feed.batch";
  readonly mode: "catchup" | "live";
  readonly rows: readonly FeedRow[];
  readonly safe_seq: number;
  readonly head_seq: number;
  readonly complete: boolean;
}

export type FeedResetReason =
  | "bootstrap_required"
  | "seq_ahead"
  | "below_floor"
  | "projection_changed";

export interface FeedReset {
  readonly t: "feed.reset";
  readonly reason: FeedResetReason;
  readonly floor_seq: number;
  readonly head_seq: number;
  readonly pending_rows?: number;
}

export interface FeedResync {
  readonly t: "feed.resync";
  readonly reason: "backpressure";
  readonly from_seq: number;
}

export interface DocSubscribed {
  readonly t: "doc.subscribed";
  readonly id: string;
  readonly materialized_version: string;
  readonly updated_at: Iso8601;
  readonly deleted: boolean;
}

export type DocErrorCode =
  | "invalid_id"
  | "not_found"
  | "gone"
  | "too_many_subscriptions"
  | "malformed_update"
  | "too_large"
  | "contended"
  | "internal";

export interface DocError {
  readonly t: "doc.error";
  readonly id: string;
  readonly code: DocErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** `"rest"` ⇒ hydrate over `GET /api/documents/:id?format=crdt` instead. */
  readonly hint?: "rest";
}

export interface DocResync {
  readonly t: "doc.resync";
  /** Absent ⇒ every document this socket subscribes to. */
  readonly id?: string;
  readonly reason: "backpressure" | "log_gap" | "server_restart" | "contended";
}

export interface Pong {
  readonly t: "pong";
  readonly ts: number;
  readonly server_time: Iso8601;
}

export interface ServerNotice {
  readonly t: "error";
  readonly code: string;
  readonly message: string;
  readonly fatal: boolean;
}

export type ServerControl =
  | Welcome
  | FeedBatch
  | FeedReset
  | FeedResync
  | DocSubscribed
  | DocError
  | DocResync
  | Pong
  | ServerNotice
  | WiringApplied;

// ---------------------------------------------------------------------------
// Client → server control messages
// ---------------------------------------------------------------------------

export interface FeedSubscribe {
  readonly t: "feed.subscribe";
  readonly since_seq: number;
  readonly include_content?: boolean;
  readonly batch_max_rows?: number;
}

export interface FeedUnsubscribe {
  readonly t: "feed.unsubscribe";
}

export interface DocSubscribe {
  readonly t: "doc.subscribe";
  readonly id: string;
  /** base64 of `Y.encodeStateVector(doc)`; omit when there is no local replica. */
  readonly sv?: string;
}

export interface DocUnsubscribe {
  readonly t: "doc.unsubscribe";
  readonly id: string;
}

export interface Ping {
  readonly t: "ping";
  readonly ts: number;
}

export type ClientControl =
  | FeedSubscribe
  | FeedUnsubscribe
  | DocSubscribe
  | DocUnsubscribe
  | Ping;

// ---------------------------------------------------------------------------
// Bootstrap stream (PROTOCOL.md §4)
// ---------------------------------------------------------------------------

export interface BootstrapHeader {
  readonly type: "header";
  readonly protocol: number;
  readonly safe_seq: number;
  readonly total: number;
  readonly limit: number;
  readonly cursor: string | null;
  readonly core_semantics_version: number;
}

export interface BootstrapRowLine extends FeedRow {
  readonly type: "row";
}

export interface BootstrapFooter {
  readonly type: "footer";
  readonly count: number;
  readonly next_cursor: string | null;
  readonly complete: boolean;
  readonly safe_seq: number;
}

export type BootstrapLine = BootstrapHeader | BootstrapRowLine | BootstrapFooter;

// ---------------------------------------------------------------------------
// Parsing and guards
// ---------------------------------------------------------------------------

const SERVER_CONTROL_TYPES = new Set<string>([
  "welcome",
  "feed.batch",
  "feed.reset",
  "feed.resync",
  "doc.subscribed",
  "doc.error",
  "doc.resync",
  "pong",
  "error",
  "wiring.applied",
]);

/** `true` when `value` is a control message this client version understands. */
export function isServerControl(value: unknown): value is ServerControl {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { t?: unknown }).t === "string" &&
    SERVER_CONTROL_TYPES.has((value as { t: string }).t)
  );
}

/**
 * Parse a text frame. Returns `undefined` for a syntactically valid control
 * message of an unknown type — forward compatibility with M4 plugin channels
 * (PROTOCOL.md §9: the client ignores what it does not know).
 */
export function parseServerControl(text: string): ServerControl | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new ProtocolError(`control frame is not JSON: ${String(cause)}`);
  }
  if (typeof value !== "object" || value === null || typeof (value as { t?: unknown }).t !== "string") {
    throw new ProtocolError("control frame has no `t` discriminator");
  }
  return isServerControl(value) ? value : undefined;
}

/** Serialize a client control message. */
export function encodeControl(message: ClientControl): string {
  return JSON.stringify(message);
}

/** `true` when the close code must stop the reconnect loop. */
export function isTerminalClose(code: number): boolean {
  return TERMINAL_CLOSE_CODES.includes(code);
}

/** A `HISTORY` payload: when the edit was made, then the update. */
export function encodeHistory(madeAtMs: number, update: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + update.length);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.max(0, Math.floor(madeAtMs))));
  out.set(update, 8);
  return out;
}

/** The inverse of {@link encodeHistory}; `undefined` for a payload too short to hold a time. */
export function decodeHistory(payload: Uint8Array): { madeAtMs: number; update: Uint8Array } | undefined {
  if (payload.length < 8) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { madeAtMs: Number(view.getBigUint64(0)), update: payload.subarray(8) };
}
