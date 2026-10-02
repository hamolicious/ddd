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
  readonly uploadId?: string;
  readonly signal: AbortSignal;
  readonly wrapper?: boolean;
  readonly onSession: (uploadId: string) => void | Promise<void>;
  readonly onProgress: (sent: number) => void;
}

const MAX_RETRACES = 8;

export async function sendInChunks(fetch: Fetch, blob: Blob, name: string, options: SendOptions): Promise<UploadResponse> {
  const { signal } = options;
  const call = async <T,>(path: string, init: RequestInit = {}): Promise<T> =>
    (await (await fetch(path, { ...init, signal })).json()) as T;

  const open = async (): Promise<Session> => {
    const session = await call<Session>("/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, size: blob.size, wrapper: options.wrapper ?? false }),
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

export interface AttachmentsApi {
  upload(blob: Blob, name: string, options?: UploadOptions): Promise<UploadResponse>;
}

export interface UploadOptions {
  readonly uploadId?: string;
  readonly signal?: AbortSignal;
  readonly wrapper?: boolean;
  readonly onSession?: (uploadId: string) => void | Promise<void>;
  readonly onProgress?: (sent: number) => void;
}

export function createAttachmentsApi(fetch: Fetch): AttachmentsApi {
  return {
    upload: (blob, name, options = {}) =>
      sendInChunks(fetch, blob, name, {
        uploadId: options.uploadId,
        signal: options.signal ?? new AbortController().signal,
        wrapper: options.wrapper,
        onSession: options.onSession ?? (() => undefined),
        onProgress: options.onProgress ?? (() => undefined),
      }),
  };
}

export function discardUpload(fetch: Fetch, uploadId: string): void {
  fetch(`/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" }).catch(() => undefined);
}

export function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

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

  secondsLeft(remaining: number): number | undefined {
    if (this.#samples === 0 || this.#rate <= 0) return undefined;
    return remaining / this.#rate;
  }
}

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
