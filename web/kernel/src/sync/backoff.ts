import { CloseCode } from "../protocol.js";

export interface BackoffOptions {
  readonly baseMs: number;
  readonly capMs: number;
  readonly maxExponent: number;
  readonly random: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 500,
  capMs: 30_000,
  maxExponent: 6,
  random: Math.random,
};

export function backoffDelay(attempt: number, options: Partial<BackoffOptions> = {}): number {
  const { baseMs, capMs, maxExponent, random } = { ...DEFAULT_BACKOFF, ...options };
  const exponent = Math.min(Math.max(attempt, 0), maxExponent);
  const ceiling = Math.min(baseMs * 2 ** exponent, capMs);
  return Math.floor(random() * ceiling);
}

export function backoffForClose(code: number | undefined, attempt: number): number | undefined {
  switch (code) {
    case CloseCode.Unauthenticated:
    case CloseCode.OriginRefused:
    case CloseCode.UnsupportedVersion:
      return undefined;
    case CloseCode.ShuttingDown:
      return backoffDelay(attempt, { baseMs: 1_000, capMs: 5_000 });
    case CloseCode.Flood:
      return backoffDelay(attempt + 2);
    default:
      return backoffDelay(attempt);
  }
}

export class BackoffState {
  #attempt = 0;
  #openedAt: number | undefined;

  constructor(
    private readonly options: Partial<BackoffOptions> = {},
    private readonly now: () => number = Date.now,
    private readonly healthyAfterMs = 60_000,
  ) {}

  get attempt(): number {
    return this.#attempt;
  }

  markOpen(): void {
    this.#openedAt = this.now();
  }

  markClosed(caughtUp: boolean): void {
    const openedAt = this.#openedAt;
    const healthy =
      caughtUp && openedAt !== undefined && this.now() - openedAt >= this.healthyAfterMs;
    this.#attempt = healthy ? 0 : this.#attempt + 1;
    this.#openedAt = undefined;
  }

  nextDelay(closeCode?: number): number | undefined {
    if (closeCode === undefined) return backoffDelay(this.#attempt, this.options);
    return backoffForClose(closeCode, this.#attempt);
  }
}
