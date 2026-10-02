import * as Y from "yjs";

import {
  FrameType,
  decodeHistory,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type BinaryFrame,
  type ClientControl,
  type ServerControl,
  type Welcome,
} from "../protocol.js";

export class MockSocket {
  static instances: MockSocket[] = [];

  binaryType = "blob";
  readyState: number = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  readonly sentControl: ClientControl[] = [];
  readonly sentBinary: BinaryFrame[] = [];
  closedWith: { code: number; reason: string } | undefined;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    MockSocket.instances.push(this);
  }

  static reset(): void {
    MockSocket.instances = [];
  }

  static get last(): MockSocket {
    const socket = MockSocket.instances[MockSocket.instances.length - 1];
    if (!socket) throw new Error("no MockSocket has been created");
    return socket;
  }

  static factory = (url: string, protocols: string[]): WebSocket =>
    new MockSocket(url, protocols) as unknown as WebSocket;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 1) throw new Error("mock socket is not open");
    if (typeof data === "string") {
      this.sentControl.push(JSON.parse(data) as ClientControl);
      return;
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sentBinary.push(decodeFrame(bytes));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(message: ServerControl | Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  deliverBinary(frame: BinaryFrame): void {
    const bytes = encodeFrame(frame);
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.onclose?.({ code, reason });
  }

  controlOfType<T extends ClientControl["t"]>(type: T): Array<Extract<ClientControl, { t: T }>> {
    return this.sentControl.filter(
      (message): message is Extract<ClientControl, { t: T }> => message.t === type,
    );
  }

  binaryOfType(type: number): BinaryFrame[] {
    return this.sentBinary.filter((frame) => frame.type === type);
  }
}

export function welcome(overrides: Partial<Welcome> = {}): Welcome {
  return {
    t: "welcome",
    protocol: PROTOCOL_VERSION,
    server_time: "2026-09-24T09:15:00.123Z",
    session: {
      user_id: "01J8ZUSER0000000000000000",
      is_admin: true,
      via: "bearer",
      expires_at: "2026-10-24T09:15:00.000Z",
    },
    feed: { head_seq: 0, safe_seq: 0, floor_seq: 0 },
    limits: {
      max_frame_bytes: 4 * 1024 * 1024,
      max_subscriptions: 32,
      feed_catchup_max_rows: 500,
      inbound_frames_per_sec: 200,
      inbound_bytes_per_sec: 2 * 1024 * 1024,
      heartbeat_secs: 25,
    },
    core_semantics_version: 1,
    ...overrides,
  };
}

export class ServerDoc {
  readonly doc = new Y.Doc();

  constructor(readonly id: string) {}

  get text(): Y.Text {
    return this.doc.getText("content");
  }

  step1(): BinaryFrame {
    return { type: FrameType.SyncStep1, docId: this.id, payload: Y.encodeStateVector(this.doc) };
  }

  step2(clientStateVector?: Uint8Array): BinaryFrame {
    return {
      type: FrameType.SyncStep2,
      docId: this.id,
      payload: Y.encodeStateAsUpdate(this.doc, clientStateVector),
    };
  }

  readonly history: { readonly madeAtMs: number; readonly text: string }[] = [];

  apply(frame: BinaryFrame): void {
    if (frame.type === FrameType.History) {
      const decoded = decodeHistory(frame.payload);
      if (!decoded) return;
      Y.applyUpdate(this.doc, decoded.update, "server");
      this.history.push({ madeAtMs: decoded.madeAtMs, text: this.text.toString() });
      return;
    }
    Y.applyUpdate(this.doc, frame.payload, "server");
  }

}

export async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
