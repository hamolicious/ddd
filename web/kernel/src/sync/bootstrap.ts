/**
 * Cold start: `GET /api/sync/bootstrap` (PROTOCOL.md §4, SPEC §4.1).
 *
 * Paged NDJSON, streamed, resumable. The client stores the `safe_seq` from the
 * first page and resumes the change feed there once the last page reports
 * `complete: true`; rows that changed during the pass are re-delivered by the
 * feed, which is harmless (rows are LWW by `seq`).
 *
 * **FROZEN INTERFACE.**
 */

import {
  DEFAULT_BOOTSTRAP_LIMIT,
  PROTOCOL_VERSION,
  type BootstrapFooter,
  type BootstrapHeader,
  type BootstrapLine,
  type FeedRow,
} from "../protocol.js";
import type { ProjectionStore, SyncCheckpoint } from "../store/projection-store.js";

/**
 * A non-2xx bootstrap response. `status` is what the sync client branches on:
 * `401` is "re-authenticate" (never "clear local data" — SPEC §5.3), everything
 * else is a retry with backoff.
 */
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
  /** Endpoint; default `/api/sync/bootstrap`. */
  readonly url?: string;
  /** Bearer token for shells/tests; browsers use the cookie. */
  readonly bearerToken?: string;
  /** Rows per page (1..1000). */
  readonly limit?: number;
  /** `all` (default) keeps Trash working offline (SPEC §6.5). */
  readonly trash?: "live" | "trashed" | "all";
  readonly includeContent?: boolean;
  /** Injectable for tests and the Node harness. */
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
  /** Ids dropped by the retain-only pass (PROTOCOL.md §4). */
  readonly removed: readonly string[];
}

export class BootstrapClient {
  constructor(
    private readonly store: ProjectionStore,
    private readonly options: BootstrapOptions = {},
  ) {}

  /** The checkpoint this pass resumes from and will overwrite when it completes. */
  checkpoint(): Promise<SyncCheckpoint> {
    return this.store.checkpoint();
  }

  /** `?probe=1`: header only — "how far behind am I?" without downloading rows. */
  async probe(signal?: AbortSignal): Promise<BootstrapHeader> {
    const lines = await this.#request(this.requestUrl(null, true), signal);
    const header = lines.find(isHeader);
    if (!header) throw new Error("bootstrap probe returned no header line");
    this.#checkProtocol(header);
    return header;
  }

  /**
   * Run a full pass: stream every page into the store, then drop local rows the
   * pass never mentioned, then persist the pinned `safe_seq` with
   * `bootstrapped: true`.
   *
   * Two orderings are load-bearing:
   *
   * 1. **The watermark is not advanced while the pass runs.** Rows go in as they
   *    arrive, but `safeSeq` only moves to the pinned value once the last page
   *    reports `complete`. A pass interrupted halfway therefore resumes as
   *    another bootstrap rather than tailing the feed from a sequence number
   *    whose rows were never stored.
   * 2. **`retainOnly` runs before the checkpoint is written**, and only for a
   *    pass that saw the whole workspace (`trash: "all"`). It is the sole
   *    garbage-collection path in the client (PROTOCOL.md §4).
   */
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
        // PROTOCOL.md §4: captured on the first page, echoed on every page. The
        // first one is the one that counts.
        safeSeq = page.header.safe_seq;
        pinned = true;
      }
      total = page.header.total;
      coreSemanticsVersion = page.header.core_semantics_version;

      if (page.rows.length > 0) {
        for (const row of page.rows) seen.add(row.id);
        await this.store.applyRows(page.rows, {
          ...before,
          // Deliberately *not* `safeSeq`: see (1) above.
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

  /**
   * One page. Exposed so the harness can measure page latency and so `run` stays
   * a loop over a well-tested unit.
   */
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

  /** Build the request URL for a page. Pure; unit-tested. */
  requestUrl(cursor: string | null, probe = false): string {
    const url = new URL(this.options.url ?? "/api/sync/bootstrap", baseUrl());
    url.searchParams.set("limit", String(this.options.limit ?? DEFAULT_BOOTSTRAP_LIMIT));
    url.searchParams.set("trash", this.options.trash ?? "all");
    if (this.options.includeContent === false) url.searchParams.set("include_content", "false");
    if (cursor) url.searchParams.set("cursor", cursor);
    if (probe) url.searchParams.set("probe", "1");
    return url.toString();
  }

  /** Fetch one NDJSON response and collect its lines. */
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
      // Browsers authenticate with the session cookie (SPEC §5.2); shells send
      // the bearer token above. Both carriers, one request shape.
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
    // Test doubles and non-streaming fetch polyfills: same NDJSON, one string.
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

/**
 * Split a byte stream into NDJSON lines. Free function because the harness
 * reuses it for the server's other streaming endpoints.
 */
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
