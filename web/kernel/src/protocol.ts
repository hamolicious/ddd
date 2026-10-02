export const PROTOCOL_VERSION = 1;

export const SUBPROTOCOL = `ddd.v${PROTOCOL_VERSION}`;

export const BEARER_SUBPROTOCOL_PREFIX = "ddd.bearer.";

export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export const DEFAULT_BATCH_MAX_ROWS = 200;

export const DEFAULT_BOOTSTRAP_LIMIT = 200;

export const FEED_SEQ_NONE = 0;

export const FrameType = {
  SyncStep1: 0x01,
  SyncStep2: 0x02,
  Update: 0x03,
  Awareness: 0x04,
  AwarenessQuery: 0x05,
  History: 0x06,
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export const RESERVED_FRAME_TYPE_FLOOR = 0x10;

export interface BinaryFrame {
  readonly type: number;
  readonly docId: string;
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

export const TERMINAL_CLOSE_CODES: readonly number[] = [
  CloseCode.Unauthenticated,
  CloseCode.OriginRefused,
  CloseCode.UnsupportedVersion,
];

export type Iso8601 = string;

export type CoreValue =
  | null
  | boolean
  | number
  | string
  | readonly CoreValue[]
  | { readonly [key: string]: CoreValue };

export type CoreMap = { readonly [key: string]: CoreValue };

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
  readonly purged: boolean;
}

export interface FeedRow extends ProjectionRow {
  readonly seq: number;
}

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
  readonly plugins_version?: number | string;
}

export interface PluginsChanged {
  readonly t: "plugins.changed";
  readonly version: number | string;
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
  readonly hint?: "rest";
}

export interface DocResync {
  readonly t: "doc.resync";
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
  | PluginsChanged;

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
  "plugins.changed",
]);

export function isServerControl(value: unknown): value is ServerControl {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { t?: unknown }).t === "string" &&
    SERVER_CONTROL_TYPES.has((value as { t: string }).t)
  );
}

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

export function encodeControl(message: ClientControl): string {
  return JSON.stringify(message);
}

export function isTerminalClose(code: number): boolean {
  return TERMINAL_CLOSE_CODES.includes(code);
}

export function encodeHistory(madeAtMs: number, update: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + update.length);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.max(0, Math.floor(madeAtMs))));
  out.set(update, 8);
  return out;
}

export function decodeHistory(payload: Uint8Array): { madeAtMs: number; update: Uint8Array } | undefined {
  if (payload.length < 8) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { madeAtMs: Number(view.getBigUint64(0)), update: payload.subarray(8) };
}
