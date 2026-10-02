import {
  BEARER_SUBPROTOCOL_PREFIX,
  ProtocolError,
  SUBPROTOCOL,
  decodeFrame,
  encodeControl,
  encodeFrame,
  parseServerControl,
  type BinaryFrame,
  type ClientControl,
  type ServerControl,
} from "../protocol.js";

export interface TransportOptions {
  readonly url?: string;
  readonly bearerToken?: string;
  readonly socketFactory?: (url: string, protocols: string[]) => WebSocket;
  readonly heartbeatMs?: number;
  readonly pongTimeoutMs?: number;
}

export interface TransportHandlers {
  onOpen?: () => void;
  onControl?: (message: ServerControl) => void;
  onBinary?: (frame: BinaryFrame) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
}

export type TransportState = "closed" | "connecting" | "open";

export const DEFAULT_HEARTBEAT_MS = 25_000;
export const DEFAULT_PONG_TIMEOUT_MS = 10_000;

export function resolveSyncUrl(url = "/api/sync", origin?: string): string {
  if (url.startsWith("ws://") || url.startsWith("wss://")) return url;
  const base =
    origin ?? (typeof location === "undefined" ? "http://127.0.0.1:8080" : location.href);
  const resolved = new URL(url, base);
  resolved.protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
  return resolved.toString();
}

export function subprotocols(bearerToken?: string): string[] {
  return bearerToken ? [SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${bearerToken}`] : [SUBPROTOCOL];
}

export function closeCodeAllowedFromClient(code: number): boolean {
  return code === 1000 || (code >= 3000 && code <= 4999);
}

export class SyncTransport {
  #socket: WebSocket | undefined;
  #state: TransportState = "closed";
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #pongDeadline: ReturnType<typeof setTimeout> | undefined;
  #heartbeatMs: number;

  constructor(
    private readonly options: TransportOptions = {},
    private readonly handlers: TransportHandlers = {},
  ) {
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  get state(): TransportState {
    return this.#state;
  }

  get bufferedAmount(): number {
    return this.#socket?.bufferedAmount ?? 0;
  }

  connect(): Promise<void> {
    if (this.#state !== "closed") {
      return Promise.reject(new Error(`sync transport is already ${this.#state}`));
    }
    const url = resolveSyncUrl(this.options.url);
    const protocols = subprotocols(this.options.bearerToken);
    const factory =
      this.options.socketFactory ?? ((target: string, p: string[]) => new WebSocket(target, p));

    this.#state = "connecting";
    const socket = factory(url, protocols);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.onopen = () => {
        this.#state = "open";
        settled = true;
        this.#startHeartbeat();
        this.handlers.onOpen?.();
        resolve();
      };
      socket.onmessage = (event: MessageEvent) => this.#onMessage(event);
      socket.onerror = () => {
        const error = new Error("sync socket error");
        if (settled) this.handlers.onError?.(error);
        else {
          settled = true;
          this.#teardown();
          reject(error);
        }
      };
      socket.onclose = (event: CloseEvent) => {
        this.#teardown();
        this.handlers.onClose?.(event.code, event.reason);
        if (!settled) {
          settled = true;
          reject(new Error(`sync socket closed before opening: ${event.code} ${event.reason}`));
        }
      };
    });
  }

  close(code = 1000, reason = "client closed"): void {
    const socket = this.#socket;
    this.#stopHeartbeat();
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(closeCodeAllowedFromClient(code) ? code : 1000, reason);
    }
  }

  sendControl(message: ClientControl): void {
    this.#requireOpen().send(encodeControl(message));
  }

  sendBinary(frame: BinaryFrame): void {
    const bytes = encodeFrame(frame);
    this.#requireOpen().send(bytes.slice().buffer);
  }

  applyHeartbeatSeconds(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.#heartbeatMs = seconds * 1_000;
    if (this.#state === "open") {
      this.#stopHeartbeat();
      this.#startHeartbeat();
    }
  }

  #onMessage(event: MessageEvent): void {
    try {
      if (typeof event.data === "string") {
        const message = parseServerControl(event.data);
        if (!message) return;
        if (message.t === "pong") this.#clearPongDeadline();
        this.handlers.onControl?.(message);
        return;
      }
      const data =
        event.data instanceof ArrayBuffer
          ? event.data
          : (event.data as { arrayBuffer?: () => Promise<ArrayBuffer> });
      if (data instanceof ArrayBuffer) {
        this.handlers.onBinary?.(decodeFrame(data));
        return;
      }
      throw new ProtocolError("binary frame arrived as a Blob; set binaryType = arraybuffer");
    } catch (cause) {
      const error =
        cause instanceof ProtocolError ? cause : new ProtocolError(`bad frame: ${String(cause)}`);
      this.handlers.onError?.(error);
      this.close(error.closeCode, error.message.slice(0, 120));
    }
  }

  #startHeartbeat(): void {
    this.#heartbeat = setInterval(() => {
      if (this.#state !== "open") return;
      try {
        this.sendControl({ t: "ping", ts: Date.now() });
      } catch {
        return;
      }
      this.#pongDeadline ??= setTimeout(() => {
        this.handlers.onError?.(new Error("no pong within the deadline; socket is dead"));
        this.close(1000, "pong timeout");
      }, this.options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS);
    }, this.#heartbeatMs);
  }

  #clearPongDeadline(): void {
    if (this.#pongDeadline !== undefined) {
      clearTimeout(this.#pongDeadline);
      this.#pongDeadline = undefined;
    }
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
    this.#clearPongDeadline();
  }

  #teardown(): void {
    this.#stopHeartbeat();
    this.#state = "closed";
    this.#socket = undefined;
  }

  #requireOpen(): WebSocket {
    const socket = this.#socket;
    if (!socket || this.#state !== "open") throw new Error("sync transport is not open");
    return socket;
  }
}
