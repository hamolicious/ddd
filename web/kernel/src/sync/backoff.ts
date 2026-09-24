/**
 * Reconnect backoff (PROTOCOL.md §8). Implemented, not stubbed: it is eight
 * lines of arithmetic and every reconnect bug traces back to getting it wrong.
 */

import { CloseCode } from "../protocol.js";

export interface BackoffOptions {
  readonly baseMs: number;
  readonly capMs: number;
  /** Attempts are capped here before the exponent runs away. */
  readonly maxExponent: number;
  /** Injectable for tests. */
  readonly random: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 500,
  capMs: 30_000,
  maxExponent: 6,
  random: Math.random,
};

/** Full jitter: `random(0, min(base * 2^n, cap))`. */
export function backoffDelay(attempt: number, options: Partial<BackoffOptions> = {}): number {
  const { baseMs, capMs, maxExponent, random } = { ...DEFAULT_BACKOFF, ...options };
  const exponent = Math.min(Math.max(attempt, 0), maxExponent);
  const ceiling = Math.min(baseMs * 2 ** exponent, capMs);
  return Math.floor(random() * ceiling);
}

/**
 * Per-close-code deviations (PROTOCOL.md §8): a deploy wants a short window so
 * the single replica is not stampeded; a flood close wants a long one.
 */
export function backoffForClose(code: number | undefined, attempt: number): number | undefined {
  switch (code) {
    case CloseCode.Unauthenticated:
    case CloseCode.OriginRefused:
    case CloseCode.UnsupportedVersion:
      return undefined; // stop; only a user action restarts the loop
    case CloseCode.ShuttingDown:
      return backoffDelay(attempt, { baseMs: 1_000, capMs: 5_000 });
    case CloseCode.Flood:
      return backoffDelay(attempt + 2);
    default:
      return backoffDelay(attempt);
  }
}

/** Mutable attempt counter with the §8 reset rule. */
export class BackoffState {
  #attempt = 0;
  #openedAt: number | undefined;

  constructor(
    private readonly options: Partial<BackoffOptions> = {},
    private readonly now: () => number = Date.now,
    /** A socket counts as healthy only after this long (PROTOCOL.md §8). */
    private readonly healthyAfterMs = 60_000,
  ) {}

  get attempt(): number {
    return this.#attempt;
  }

  markOpen(): void {
    this.#openedAt = this.now();
  }

  /**
   * Call on close. Resets the counter when the socket was open long enough and
   * the feed had caught up; otherwise increments it.
   */
  markClosed(caughtUp: boolean): void {
    const openedAt = this.#openedAt;
    const healthy =
      caughtUp && openedAt !== undefined && this.now() - openedAt >= this.healthyAfterMs;
    this.#attempt = healthy ? 0 : this.#attempt + 1;
    this.#openedAt = undefined;
  }

  /** Delay before the next attempt, or `undefined` when the loop must stop. */
  nextDelay(closeCode?: number): number | undefined {
    if (closeCode === undefined) return backoffDelay(this.#attempt, this.options);
    return backoffForClose(closeCode, this.#attempt);
  }
}
