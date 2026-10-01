/**
 * The harness's REST half: auth, documents, the bootstrap stream, `/metrics`.
 *
 * The harness talks to a **real** server (SPEC §9 M2), so everything here is
 * plain `fetch` against the routes of `backend/README.md`. Two deliberate
 * choices:
 *
 * - **Bearer sessions, one per simulated client.** Cookies would share a session
 *   across clients and the socket cap is per session (8, PROTOCOL.md §1.3);
 *   separate logins give separate sessions, which is what N real devices look
 *   like.
 * - **Timestamps are read as RFC 3339 strings** and never re-encoded. If a
 *   response ever carries `{"$date": …}` the harness fails loudly rather than
 *   coping (PROTOCOL.md §2.1).
 */

import type { BootstrapHeader, BootstrapLine, FeedRow } from "../../kernel/src/protocol.js";

/** `GET /api/documents/:id` — the materialized view (`domain::DocumentView`). */
export interface DocumentView {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly fm: Record<string, unknown>;
  readonly plugins: Record<string, unknown>;
  readonly fm_parse_error: boolean;
  readonly materialized_version: string;
  readonly created_at: string;
  readonly created_by: string | null;
  readonly updated_at: string;
  readonly updated_by: string | null;
  readonly deleted: boolean;
  readonly deleted_at?: string | null;
  readonly deleted_by?: string | null;
}

export interface CrdtState {
  /** Full encoded CRDT state, update encoding v1. */
  readonly state: Uint8Array;
  /** `x-state-vector`, decoded. */
  readonly stateVector: Uint8Array;
}

export interface BootstrapMeasurement {
  readonly ms: number;
  readonly bytes: number;
  readonly pages: number;
  readonly rows: number;
  readonly safeSeq: number;
  readonly total: number;
  readonly coreSemanticsVersion: number;
}

export interface BootstrapOptions {
  readonly limit?: number;
  readonly includeContent?: boolean;
  readonly trash?: "live" | "trashed" | "all";
  readonly onRow?: (row: FeedRow) => void;
  readonly onPage?: (page: { readonly rows: number; readonly bytes: number }) => void;
}

/**
 * Protocol violations the harness *notices* while doing something else, collected
 * rather than thrown.
 *
 * The harness is the executable half of PROTOCOL.md §10's conformance checklist, so
 * it watches every response it already has in hand: extended JSON where an RFC 3339
 * string is required (§2.1), a `safe_seq` that moves between bootstrap pages (§4),
 * and so on. Collecting instead of throwing matters — a stray `$date` on an *auth*
 * route must not stop the run from testing convergence, which is exactly what an
 * exception here did. `contractual` violations fail the run; the rest are reported.
 */
export interface ProtocolViolation {
  readonly where: string;
  readonly detail: string;
  readonly contractual: boolean;
  /** How many times this violation was seen; the `detail` is the first sighting. */
  repeats: number;
}

const violations: ProtocolViolation[] = [];

export function protocolViolations(): readonly ProtocolViolation[] {
  return violations;
}

/**
 * Record one violation. Repeats of the same `where` collapse into a count — a
 * broken invariant that fires on every page of every bootstrap should be one line
 * in the report, not two hundred.
 */
export function recordProtocolViolation(where: string, detail: string, contractual = true): void {
  const existing = violations.find((candidate) => candidate.where === where);
  if (existing) {
    existing.repeats += 1;
    return;
  }
  violations.push({ where, detail, contractual, repeats: 1 });
}

/** Watch a response body for MongoDB extended JSON (PROTOCOL.md §2.1). */
export function recordWireViolations(method: string, path: string, body: string): void {
  if (!body.includes('"$date"') && !body.includes('"$numberLong"')) return;
  const at = Math.max(0, body.indexOf('"$date"') - 60);
  recordProtocolViolation(
    `${method} ${path}`,
    `MongoDB extended JSON on the wire: …${body.slice(at, at + 160)}…`,
    /^\/api\/(documents|sync)/.test(path),
  );
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`${method} ${path} → ${status}: ${body.slice(0, 400)}`);
    this.name = "HttpError";
  }
}

/** A thin, honest client for the routes the harness needs. */
export class RestClient {
  constructor(
    readonly baseUrl: string,
    public token?: string,
  ) {}

  withToken(token: string): RestClient {
    return new RestClient(this.baseUrl, token);
  }

  url(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}`, ...extra } : { ...extra };
  }

  async request(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(this.url(path), {
      ...init,
      method,
      headers: { ...this.headers(), ...((init.headers as Record<string, string>) ?? {}) },
    });
    if (!response.ok) {
      throw new HttpError(response.status, method, path, await response.text());
    }
    return response;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, {
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    recordWireViolations(method, path, text);
    return text === "" ? (undefined as T) : (JSON.parse(text) as T);
  }

  // -- auth ----------------------------------------------------------------

  authState(): Promise<{ needs_first_user: boolean; invite_required: boolean }> {
    return this.json("GET", "/api/auth/bootstrap");
  }

  async login(email: string, password: string): Promise<string> {
    const session = await this.json<{ token?: string }>("POST", "/api/auth/login", {
      email,
      password,
      bearer: true,
    });
    if (!session.token) throw new Error("login did not return a bearer token");
    return session.token;
  }

  async register(
    email: string,
    password: string,
    invite?: string,
  ): Promise<string> {
    const session = await this.json<{ token?: string }>("POST", "/api/auth/register", {
      email,
      password,
      name: "convergence harness",
      ...(invite ? { invite } : {}),
      bearer: true,
    });
    if (!session.token) throw new Error("register did not return a bearer token");
    return session.token;
  }

  // -- documents -----------------------------------------------------------

  /** `POST /api/documents`. A 409 (id exists) resolves to `"exists"` — seeding is idempotent. */
  async createDocument(id: string, content: string): Promise<"created" | "exists"> {
    const response = await fetch(this.url("/api/documents"), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ id, content }),
    });
    if (response.status === 409) {
      await response.text();
      return "exists";
    }
    if (!response.ok) {
      throw new HttpError(response.status, "POST", "/api/documents", await response.text());
    }
    await response.text();
    return "created";
  }

  getDocument(id: string): Promise<DocumentView> {
    return this.json("GET", `/api/documents/${id}`);
  }

  replaceDocument(id: string, content: string): Promise<DocumentView> {
    return this.json("PUT", `/api/documents/${id}`, { content });
  }

  async crdtState(id: string): Promise<CrdtState> {
    const response = await this.request("GET", `/api/documents/${id}?format=crdt`);
    const header = response.headers.get("x-state-vector") ?? "";
    return {
      state: new Uint8Array(await response.arrayBuffer()),
      stateVector: header === "" ? new Uint8Array() : base64ToBytes(header),
    };
  }

  listDocuments(query: string = ""): Promise<{ documents: DocumentView[]; next_cursor?: string }> {
    return this.json("GET", `/api/documents${query}`);
  }

  // -- sync ----------------------------------------------------------------

  /**
   * `GET /api/sync/bootstrap?probe=1` — "how far behind am I, and what is
   * `safe_seq`?" (PROTOCOL.md §4).
   *
   * The document says a probe "returns a single header line only"; the server
   * actually sends a header *and* a footer, which is harmless but means the
   * response is NDJSON rather than one JSON object. Parsed line-wise here, and
   * flagged in the INTEGRATION notes — one of the two has to move.
   */
  async probeBootstrap(): Promise<BootstrapHeader> {
    const response = await this.request("GET", "/api/sync/bootstrap?probe=1");
    const text = await response.text();
    recordWireViolations("GET", "/api/sync/bootstrap", text);
    const first = text.split("\n").find((line) => line.trim() !== "");
    if (!first) throw new Error("bootstrap probe returned an empty body");
    return JSON.parse(first) as BootstrapHeader;
  }

  /**
   * Stream the whole bootstrap, page by page, counting wall clock and bytes.
   * This is the measurement behind the "5 000 documents < 30 s on LAN" target
   * (SPEC §4.1) as seen from outside the browser.
   */
  async bootstrap(options: BootstrapOptions = {}): Promise<BootstrapMeasurement> {
    const limit = options.limit ?? 200;
    const trash = options.trash ?? "all";
    const includeContent = options.includeContent ?? true;

    const started = performance.now();
    let cursor: string | null = null;
    let bytes = 0;
    let pages = 0;
    let rows = 0;
    let safeSeq = 0;
    let total = 0;
    let semantics = 0;

    for (;;) {
      const query = new URLSearchParams({
        limit: String(limit),
        include_content: String(includeContent),
        trash,
      });
      if (cursor) query.set("cursor", cursor);
      const response = await this.request("GET", `/api/sync/bootstrap?${query.toString()}`);
      let pageRows = 0;
      let pageBytes = 0;
      let footer: { next_cursor: string | null; complete: boolean; safe_seq: number } | undefined;

      for await (const line of ndjsonLines(response)) {
        pageBytes += line.length + 1;
        recordWireViolations("GET", "/api/sync/bootstrap", line);
        const parsed = JSON.parse(line) as BootstrapLine;
        if (parsed.type === "header") {
          if (pages === 0) {
            safeSeq = parsed.safe_seq;
            total = parsed.total;
            semantics = parsed.core_semantics_version;
          } else if (parsed.safe_seq !== safeSeq) {
            // PROTOCOL.md §4: captured on the first page, echoed unchanged on every
            // page — because the client resumes the feed from it and a *later*
            // number would skip everything that changed during the pass. Reported,
            // not thrown, and the smallest value seen is the one kept: resuming too
            // early costs duplicate rows (harmless, LWW by seq), resuming too late
            // loses documents.
            recordProtocolViolation(
              "GET /api/sync/bootstrap",
              `safe_seq changed between pages (page 0 said ${safeSeq}, page ${pages} said ${parsed.safe_seq}); ` +
                "PROTOCOL.md §4 requires it echoed unchanged",
            );
            safeSeq = Math.min(safeSeq, parsed.safe_seq);
          }
        } else if (parsed.type === "row") {
          pageRows += 1;
          options.onRow?.(parsed);
        } else {
          footer = parsed;
          if (parsed.safe_seq !== safeSeq) {
            recordProtocolViolation(
              "GET /api/sync/bootstrap",
              `footer safe_seq ${parsed.safe_seq} differs from the pinned ${safeSeq} (PROTOCOL.md §4)`,
            );
            safeSeq = Math.min(safeSeq, parsed.safe_seq);
          }
        }
      }

      bytes += pageBytes;
      rows += pageRows;
      pages += 1;
      options.onPage?.({ rows: pageRows, bytes: pageBytes });

      if (!footer) throw new Error("bootstrap page ended without a footer line");
      if (footer.complete) break;
      if (!footer.next_cursor) throw new Error("incomplete bootstrap page carried no next_cursor");
      cursor = footer.next_cursor;
    }

    return {
      ms: Math.round(performance.now() - started),
      bytes,
      pages,
      rows,
      safeSeq,
      total,
      coreSemanticsVersion: semantics,
    };
  }

  // -- ops -----------------------------------------------------------------

  /** `/metrics` as a flat name → number map (labels dropped, samples summed). */
  async metrics(): Promise<Record<string, number>> {
    const response = await fetch(this.url("/metrics"));
    if (!response.ok) return {};
    return parseMetrics(await response.text());
  }
}

/**
 * Prometheus text 0.0.4 → `{ metric: number }`. Labels are dropped and samples
 * summed: the harness reports counters ("how many updates did the server
 * apply"), not per-label breakdowns. Histogram buckets are skipped; `_sum` and
 * `_count` are kept, which is what a latency report needs.
 */
export function parseMetrics(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[0-9.eE+]+|NaN|\+Inf|-Inf)$/.exec(line);
    if (!match) continue;
    const [, name, , value] = match as unknown as [string, string, string | undefined, string];
    if (name.endsWith("_bucket")) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) continue;
    out[name] = (out[name] ?? 0) + parsed;
  }
  return out;
}

/** Iterate the lines of an NDJSON response body without buffering the whole thing. */
export async function* ndjsonLines(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (!body) throw new Error("response has no body to stream");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") yield line;
      newline = buffer.indexOf("\n");
    }
  }
  const tail = (buffer + decoder.decode()).trim();
  if (tail !== "") yield tail;
}

export function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Get a usable bearer token, registering the first user if the workspace is
 * empty (SPEC §5.1: first user → admin, no invite). A workspace that already
 * requires invites and does not know these credentials is a setup error, and the
 * message says exactly what to do about it.
 */
export async function authenticate(
  baseUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const anonymous = new RestClient(baseUrl);
  try {
    return await anonymous.login(email, password);
  } catch (error) {
    if (!(error instanceof HttpError) || (error.status !== 401 && error.status !== 422)) throw error;
  }
  const state = await anonymous.authState();
  const invite = process.env.DDD_INVITE;
  if (!state.needs_first_user && !invite) {
    throw new Error(
      `no account for ${email} and the workspace already has users: ` +
        "create one and pass DDD_EMAIL/DDD_PASSWORD, or set DDD_INVITE=<invite token>",
    );
  }
  return anonymous.register(email, password, invite);
}
