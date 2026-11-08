/**
 * When quotes of remote statuses are checked again, as Mastodon's
 * `ActivityPub::RefetchAndVerifyQuoteWorker` and
 * `ActivityPub::QuoteRefreshWorker`. `random` is a number in `[0, 1)`.
 */

/**
 * How many times a pending quote is checked again after its quoted note or
 * stamp could not be fetched: the first run and Sidekiq's `retry: 3`.
 */
const REFETCH_MAX_ATTEMPTS = 4;

/** How long an accepted quote's stamp stays trusted before a view checks it again (`BACKGROUND_REFRESH_INTERVAL`). */
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** How far a refresh is spread out after the view that asked for it (`REFRESH_DEADLINE`). */
const REFRESH_DEADLINE_SECONDS = 6 * 60 * 60;

export const QuoteRetry = {
  refetchMaxAttempts: REFETCH_MAX_ATTEMPTS,
  refreshIntervalMs: REFRESH_INTERVAL_MS,
  /**
   * The delay before refetch `attempt` (1 is the first). The first waits 30
   * to 600 seconds, as `perform_in(rand(30..600))`; each later one Sidekiq's
   * `ExponentialBackoff` for retry `attempt - 2`: `15 + 10n⁴ + rand(10n⁴)`.
   */
  refetchDelaySeconds: (attempt: number, random: number): number => {
    if (attempt <= 1) {
      return 30 + Math.floor(random * 571);
    }
    const spread = 10 * (attempt - 2) ** 4;
    return 15 + spread + Math.floor(random * spread);
  },
  /** The attempt after `attempt`, or `undefined` once the attempts are spent. */
  nextRefetchAttempt: (attempt: number): number | undefined =>
    attempt < REFETCH_MAX_ATTEMPTS ? attempt + 1 : undefined,
  /** The delay of a refresh, spread over {@link REFRESH_DEADLINE_SECONDS} as `perform_in(rand(REFRESH_DEADLINE))`. */
  refreshDelaySeconds: (random: number): number => Math.floor(random * REFRESH_DEADLINE_SECONDS),
} as const;
