import {
  DEFAULT_BOOTSTRAP_LIMIT,
  PROTOCOL_VERSION,
  type BootstrapFooter,
  type BootstrapHeader,
  type BootstrapLine,
  type FeedRow,
} from "../protocol.js";
import type { ProjectionStore, SyncCheckpoint } from "../store/projection-store.js";

export class BootstrapHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BootstrapHttpError";
  }
}

export interface BootstrapOptions {
  readonly url?: string;
  readonly bearerToken?: string;
  readonly limit?: number;
  readonly trash?: "live" | "trashed" | "all";
  readonly includeContent?: boolean;
  readonly fetchImpl?: typeof fetch;
}

export interface BootstrapProgress {
  readonly rows: number;
  readonly total: number;
  readonly safeSeq: number;
  readonly complete: boolean;
}

export interface BootstrapResult {
  readonly safeSeq: number;
  readonly rows: number;
  readonly removed: readonly string[];
}

export class BootstrapClient {
  constructor(
    private readonly store: ProjectionStore,
    private readonly options: BootstrapOptions = {},
  ) {}

  checkpoint(): Promise<SyncCheckpoint> {
    return this.store.checkpoint();
  }

  async probe(signal?: AbortSignal): Promise<BootstrapHeader> {
    const lines = await this.#request(this.requestUrl(null, true), signal);
    const header = lines.find(isHeader);
    if (!header) throw new Error("bootstrap probe returned no header line");
    this.#checkProtocol(header);
    return header;
  }

  async run(
    onProgress?: (progress: BootstrapProgress) => void,
    signal?: AbortSignal,
  ): Promise<BootstrapResult> {
    const before = await this.store.checkpoint();
    const seen = new Set<string>();
    let cursor: string | null = null;
    let safeSeq = 0;
    let total = 0;
    let coreSemanticsVersion: number | null = before.coreSemanticsVersion;
    let rows = 0;
    let pinned = false;

    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("bootstrap aborted");
      const page = await this.page(cursor, signal);
      if (!pinned) {
        safeSeq = page.header.safe_seq;
        pinned = true;
      }
      total = page.header.total;
      coreSemanticsVersion = page.header.core_semantics_version;

      if (page.rows.length > 0) {
        for (const row of page.rows) seen.add(row.id);
        await this.store.applyRows(page.rows, {
          ...before,
          safeSeq: before.safeSeq,
          updatedAt: Date.now(),
          coreSemanticsVersion,
        });
        rows += page.rows.length;
      }
      onProgress?.({ rows, total, safeSeq, complete: false });

      if (page.complete) break;
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    const authoritative = (this.options.trash ?? "all") === "all";
    const removed = authoritative ? await this.store.retainOnly(seen) : [];
    await this.store.setCheckpoint({
      safeSeq,
      updatedAt: Date.now(),
      coreSemanticsVersion,
      bootstrapped: true,
    });
    onProgress?.({ rows, total, safeSeq, complete: true });
    return { safeSeq, rows, removed };
  }

  async page(
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<{
    readonly header: BootstrapHeader;
    readonly rows: readonly FeedRow[];
    readonly nextCursor: string | null;
    readonly complete: boolean;
  }> {
    const lines = await this.#request(this.requestUrl(cursor), signal);
    const header = lines.find(isHeader);
    if (!header) throw new Error("bootstrap page returned no header line");
    this.#checkProtocol(header);
    const footer = lines.find(isFooter);
    if (!footer) throw new Error("bootstrap page returned no footer line");
    const rows: FeedRow[] = [];
    for (const line of lines) {
      if (isRow(line)) {
        const { type: _type, ...row } = line;
        rows.push(row);
      }
    }
    return {
      header,
      rows,
      nextCursor: footer.next_cursor,
      complete: footer.complete,
    };
  }

  requestUrl(cursor: string | null, probe = false): string {
    const url = new URL(this.options.url ?? "/api/sync/bootstrap", baseUrl());
    url.searchParams.set("limit", String(this.options.limit ?? DEFAULT_BOOTSTRAP_LIMIT));
    url.searchParams.set("trash", this.options.trash ?? "all");
    if (this.options.includeContent === false) url.searchParams.set("include_content", "false");
    if (cursor) url.searchParams.set("cursor", cursor);
    if (probe) url.searchParams.set("probe", "1");
    return url.toString();
  }

  async #request(url: string, signal?: AbortSignal): Promise<BootstrapLine[]> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) throw new Error("no fetch implementation available for bootstrap");
    const headers: Record<string, string> = { accept: "application/x-ndjson" };
    if (this.options.bearerToken) {
      headers.authorization = `Bearer ${this.options.bearerToken}`;
    }
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      credentials: "include",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new BootstrapHttpError(
        response.status,
        `bootstrap ${url} failed: ${response.status} ${detail.slice(0, 200)}`,
      );
    }
    const lines: BootstrapLine[] = [];
    if (response.body) {
      for await (const line of ndjson(response.body, signal)) {
        lines.push(line as BootstrapLine);
      }
      return lines;
    }
    for (const text of (await response.text()).split("\n")) {
      const trimmed = text.trim();
      if (trimmed) lines.push(JSON.parse(trimmed) as BootstrapLine);
    }
    return lines;
  }

  #checkProtocol(header: BootstrapHeader): void {
    if (header.protocol !== PROTOCOL_VERSION) {
      throw new Error(
        `bootstrap speaks protocol ${header.protocol}, this client speaks ${PROTOCOL_VERSION}`,
      );
    }
  }
}

function isHeader(line: BootstrapLine): line is BootstrapHeader {
  return line.type === "header";
}

function isFooter(line: BootstrapLine): line is BootstrapFooter {
  return line.type === "footer";
}

function isRow(line: BootstrapLine): line is BootstrapLine & { type: "row" } & FeedRow {
  return line.type === "row";
}

export async function* ndjson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line);
        newline = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail) yield JSON.parse(tail);
  } finally {
    reader.releaseLock();
  }
}

function baseUrl(): string {
  return typeof location === "undefined" ? "http://127.0.0.1:8080" : location.href;
}
