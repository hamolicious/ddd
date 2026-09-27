/**
 * Sending one file in chunks (`/api/uploads`, the server's `routes/uploads.rs`), so an
 * interrupted upload carries on from the last chunk the server kept instead of starting
 * again: after a dropped connection, a reload, or a pause.
 *
 * {@link sendInChunks} opens an upload on the server (or picks up the one it is given),
 * sends the chunks in order and completes it. When the server says it is somewhere else
 * (a 409: an answer lost on the way back, a chunk it found missing) it asks where, and
 * carries on from there; when the upload is gone (a 404: swept after a day unused) it
 * opens a new one. Anything else is the caller's to handle, an abort included.
 *
 * Also here: the time-left estimate ({@link Throughput}) and how sizes and durations are
 * written in the upload's notice.
 */

export interface UploadResponse {
  readonly attachment: {
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
    readonly sha256: string;
    readonly revision: number;
  };
  readonly reference: string;
  readonly document_id?: string;
}

interface Session {
  readonly id: string;
  readonly size: number;
  readonly offset: number;
  readonly chunk_size: number;
}

export type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface SendOptions {
  /** The upload to carry on with, if one was opened before. */
  readonly uploadId?: string;
  readonly signal: AbortSignal;
  /** Ask the server to create the ordinary document that represents this file. */
  readonly wrapper?: boolean;
  /** `fm.path` for that wrapper document. Ignored when `wrapper` is false. */
  readonly path?: string;
  /** A new upload was opened on the server: keep its id, so a later attempt resumes it. */
  readonly onSession: (uploadId: string) => void | Promise<void>;
  /** The server has `sent` bytes. */
  readonly onProgress: (sent: number) => void;
}

/** How many times the server may send it back or away before the upload gives up. */
const MAX_RETRACES = 8;

export async function sendInChunks(fetch: Fetch, blob: Blob, name: string, options: SendOptions): Promise<UploadResponse> {
  const { signal } = options;
  const call = async <T,>(path: string, init: RequestInit = {}): Promise<T> =>
    (await (await fetch(path, { ...init, signal })).json()) as T;

  const open = async (): Promise<Session> => {
    const session = await call<Session>("/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, size: blob.size, wrapper: options.wrapper ?? false, path: options.path }),
    });
    await options.onSession(session.id);
    return session;
  };
  const where = (id: string): Promise<Session> => call<Session>(`/uploads/${encodeURIComponent(id)}`);

  let session: Session | undefined;
  if (options.uploadId) {
    try {
      session = await where(options.uploadId);
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
  }
  session ??= await open();

  let retraces = 0;
  const retrace = (error: unknown): boolean => {
    const status = statusOf(error);
    return (status === 409 || status === 404) && (retraces += 1) <= MAX_RETRACES;
  };

  let offset = session.offset;
  for (;;) {
    options.onProgress(offset);
    while (offset < blob.size) {
      signal.throwIfAborted();
      const end = Math.min(offset + session.chunk_size, blob.size);
      try {
        const next = await call<Session>(`/uploads/${encodeURIComponent(session.id)}?offset=${String(offset)}`, {
          method: "PATCH",
          headers: { "content-type": "application/octet-stream" },
          body: blob.slice(offset, end),
        });
        offset = next.offset;
      } catch (error) {
        if (!retrace(error)) throw error;
        ({ session, offset } = await relocate(error, session));
      }
      options.onProgress(offset);
    }
    try {
      return await call<UploadResponse>(`/uploads/${encodeURIComponent(session.id)}/complete`, { method: "POST" });
    } catch (error) {
      if (!retrace(error)) throw error;
      ({ session, offset } = await relocate(error, session));
    }
  }

  /** Where to carry on after a 409 (ask the server) or a 404 (a new upload, from 0). */
  async function relocate(error: unknown, current: Session): Promise<{ session: Session; offset: number }> {
    if (statusOf(error) === 409) {
      try {
        const found = await where(current.id);
        return { session: found, offset: found.offset };
      } catch (lookup) {
        if (statusOf(lookup) !== 404) throw lookup;
      }
    }
    const fresh = await open();
    return { session: fresh, offset: fresh.offset };
  }
}

/** Public service returned by the `attachments` plugin to declared dependents. */
export interface AttachmentsApi {
  /** Upload one file through the server's resumable chunk protocol. */
  upload(blob: Blob, name: string, options?: UploadOptions): Promise<UploadResponse>;
}

export interface UploadOptions {
  readonly uploadId?: string;
  readonly signal?: AbortSignal;
  readonly wrapper?: boolean;
  readonly path?: string;
  readonly onSession?: (uploadId: string) => void | Promise<void>;
  readonly onProgress?: (sent: number) => void;
}

/** Bind the generic attachment service to the authenticated kernel fetch. */
export function createAttachmentsApi(fetch: Fetch): AttachmentsApi {
  return {
    upload: (blob, name, options = {}) =>
      sendInChunks(fetch, blob, name, {
        uploadId: options.uploadId,
        signal: options.signal ?? new AbortController().signal,
        wrapper: options.wrapper,
        path: options.path,
        onSession: options.onSession ?? (() => undefined),
        onProgress: options.onProgress ?? (() => undefined),
      }),
  };
}

/** Cancel an upload on the server. Best effort: one left behind is swept after a day. */
export function discardUpload(fetch: Fetch, uploadId: string): void {
  fetch(`/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" }).catch(() => undefined);
}

export function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

/**
 * Upload speed, smoothed over the last few chunks, and the time left at that speed.
 * Starts again after a pause or a lost connection ({@link reset}), since the time spent
 * waiting says nothing about the speed.
 */
export class Throughput {
  #last: { readonly bytes: number; readonly at: number } | undefined;
  #rate = 0;
  #samples = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  reset(): void {
    this.#last = undefined;
    this.#rate = 0;
    this.#samples = 0;
  }

  sample(bytes: number): void {
    const at = this.now();
    const last = this.#last;
    this.#last = { bytes, at };
    if (!last || bytes <= last.bytes || at <= last.at) return;
    const rate = ((bytes - last.bytes) / (at - last.at)) * 1000;
    this.#rate = this.#samples === 0 ? rate : this.#rate * 0.7 + rate * 0.3;
    this.#samples += 1;
  }

  /** Seconds left for `remaining` bytes, or `undefined` until there is a speed to go by. */
  secondsLeft(remaining: number): number | undefined {
    if (this.#samples === 0 || this.#rate <= 0) return undefined;
    return remaining / this.#rate;
  }
}

/** `12.4 MB`, `980 KB`, `12 bytes`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit] ?? "TB"}`;
}

/** `a few seconds left`, `42 s left`, `3 min 20 s left`, `1 h 5 min left`. */
export function formatTimeLeft(seconds: number): string {
  const whole = Math.ceil(seconds);
  if (whole < 5) return "a few seconds left";
  if (whole < 60) return `${String(whole)} s left`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) {
    const rest = whole % 60;
    return rest === 0 || minutes >= 10 ? `${String(minutes)} min left` : `${String(minutes)} min ${String(rest)} s left`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)} h left` : `${String(hours)} h ${String(rest)} min left`;
}
