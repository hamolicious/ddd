import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CloseCode,
  FrameType,
  MAX_FRAME_BYTES,
  ProtocolError,
  decodeFrame,
  encodeFrame,
  isTerminalClose,
  parseServerControl,
} from "./protocol.js";
import { backoffDelay, backoffForClose } from "./sync/backoff.js";
import { BackoffState } from "./sync/backoff.js";
import {
  SyncTransport,
  resolveSyncUrl,
  subprotocols,
  type TransportHandlers,
} from "./sync/transport.js";
import { MockSocket } from "./sync/testing.js";

const ULID = "01J8ZQ0M3M4YQV0X0PTN9R2G7C";

describe("binary framing", () => {
  it("round-trips a frame", () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const frame = decodeFrame(encodeFrame({ type: FrameType.Update, docId: ULID, payload }));
    expect(frame.type).toBe(FrameType.Update);
    expect(frame.docId).toBe(ULID);
    expect([...frame.payload]).toEqual([...payload]);
  });

  it("rejects an empty payload-less frame", () => {
    expect(() => decodeFrame(new Uint8Array([0x01, 0x02]))).toThrow(ProtocolError);
  });

  it("rejects a frame whose id runs past the end", () => {
    expect(() => decodeFrame(new Uint8Array([0x01, 0xff, 0x41]))).toThrow(ProtocolError);
  });

  it("refuses to encode past the frame ceiling", () => {
    const payload = new Uint8Array(MAX_FRAME_BYTES);
    expect(() => encodeFrame({ type: FrameType.SyncStep2, docId: ULID, payload })).toThrow(
      ProtocolError,
    );
  });
});

describe("control messages", () => {
  it("parses a known type", () => {
    const message = parseServerControl(JSON.stringify({ t: "pong", ts: 1, server_time: "x" }));
    expect(message?.t).toBe("pong");
  });

  it("ignores an unknown type (forward compatibility)", () => {
    expect(parseServerControl(JSON.stringify({ t: "plugin.event", payload: 1 }))).toBeUndefined();
  });

  it("rejects a frame with no discriminator", () => {
    expect(() => parseServerControl("{}")).toThrow(ProtocolError);
  });
});

describe("reconnect policy", () => {
  it("is bounded by the cap with full jitter", () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const delay = backoffDelay(attempt, { random: () => 0.999 });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
  });

  it("stops the loop on terminal close codes", () => {
    expect(backoffForClose(CloseCode.Unauthenticated, 0)).toBeUndefined();
    expect(isTerminalClose(CloseCode.UnsupportedVersion)).toBe(true);
    expect(isTerminalClose(CloseCode.ShuttingDown)).toBe(false);
  });

  it("uses the short window for a deploy", () => {
    expect(backoffForClose(CloseCode.ShuttingDown, 5)).toBeLessThanOrEqual(5_000);
  });
});

describe("handshake", () => {
  it("offers the bearer subprotocol only when a token is present", () => {
    expect(subprotocols()).toEqual(["life-manager.v1"]);
    expect(subprotocols("abc")).toEqual(["life-manager.v1", "life-manager.bearer.abc"]);
  });
});

describe("the transport", () => {
  const transports: SyncTransport[] = [];

  afterEach(() => {
    for (const transport of transports.splice(0)) transport.close();
    MockSocket.reset();
    vi.useRealTimers();
  });

  async function open(handlers: TransportHandlers = {}, heartbeatMs = 3_600_000) {
    MockSocket.reset();
    const transport = new SyncTransport(
      {
        url: "/api/sync",
        socketFactory: MockSocket.factory,
        heartbeatMs,
        pongTimeoutMs: 50,
      },
      handlers,
    );
    transports.push(transport);
    const opening = transport.connect();
    MockSocket.last.open();
    await opening;
    return { transport, socket: MockSocket.last };
  }

  it("resolves a page-relative path to a ws URL", () => {
    expect(resolveSyncUrl("/api/sync", "https://app.example.com/notes")).toBe(
      "wss://app.example.com/api/sync",
    );
    expect(resolveSyncUrl("/api/sync", "http://127.0.0.1:5173/")).toBe(
      "ws://127.0.0.1:5173/api/sync",
    );
    expect(resolveSyncUrl("wss://elsewhere/api/sync")).toBe("wss://elsewhere/api/sync");
  });

  it("asks for arraybuffer frames and reports decoded ones", async () => {
    const frames: number[] = [];
    const { socket } = await open({ onBinary: (frame) => frames.push(frame.type) });
    expect(socket.binaryType).toBe("arraybuffer");

    const bytes = encodeFrame({
      type: FrameType.Update,
      docId: ULID,
      payload: new Uint8Array([1, 2]),
    });
    socket.onmessage?.({ data: bytes.buffer.slice(0) });
    expect(frames).toEqual([FrameType.Update]);
  });

  it("closes 4400 on a frame it cannot decode", async () => {
    const errors: Error[] = [];
    const frames: number[] = [];
    // `onBinary` has to be present: the transport decodes inside an optional call,
    // so a client with no binary handler never validates framing at all.
    const { socket } = await open({
      onBinary: (frame) => frames.push(frame.type),
      onError: (error) => errors.push(error),
    });

    socket.onmessage?.({ data: new Uint8Array([0x01, 0xff, 0x41]).buffer });

    expect(errors[0]).toBeInstanceOf(ProtocolError);
    expect(frames).toEqual([]);
    expect(socket.closedWith?.code).toBe(CloseCode.ProtocolError);
  });

  it("heartbeats and gives up when no pong comes back", async () => {
    vi.useFakeTimers();
    const errors: Error[] = [];
    MockSocket.reset();
    const transport = new SyncTransport(
      {
        url: "/api/sync",
        socketFactory: MockSocket.factory,
        heartbeatMs: 1_000,
        pongTimeoutMs: 500,
      },
      { onError: (error) => errors.push(error) },
    );
    transports.push(transport);
    const opening = transport.connect();
    MockSocket.last.open();
    await opening;
    const socket = MockSocket.last;

    vi.advanceTimersByTime(1_000);
    expect(socket.controlOfType("ping")).toHaveLength(1);
    // A pong stops the deadline...
    socket.onmessage?.({ data: JSON.stringify({ t: "pong", ts: 1, server_time: "x" }) });
    vi.advanceTimersByTime(1_000);
    expect(errors).toHaveLength(0);

    // ...and its absence declares the socket dead (PROTOCOL.md §5).
    vi.advanceTimersByTime(600);
    expect(errors.map((error) => error.message)).toContain(
      "no pong within the deadline; socket is dead",
    );
  });

  it("refuses to send once the socket is gone", async () => {
    const { transport, socket } = await open();
    socket.serverClose(1001, "bye");
    expect(() => transport.sendControl({ t: "feed.unsubscribe" })).toThrow(/not open/);
  });
});

describe("backoff bookkeeping", () => {
  it("resets only after a socket that was open long enough and caught up", () => {
    let now = 0;
    const state = new BackoffState({ random: () => 0.5 }, () => now, 60_000);

    state.markOpen();
    now = 10_000;
    state.markClosed(true); // open, but not for long enough
    expect(state.attempt).toBe(1);

    state.markOpen();
    now = 200_000;
    state.markClosed(false); // long enough, but never caught up
    expect(state.attempt).toBe(2);

    state.markOpen();
    now = 400_000;
    state.markClosed(true);
    expect(state.attempt).toBe(0);
  });

  it("starts a flood close well back in the sequence", () => {
    const flooded = backoffForClose(CloseCode.Flood, 0) ?? 0;
    expect(flooded).toBeLessThanOrEqual(2_000);
  });
});
