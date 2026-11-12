import type { Result } from "neverthrow";
import type { RateLimitCounterState, RateLimitIncrement } from "./rate-limit";
import type { RepositoryError } from "./repository-error";

/**
 * Count `hits` (each `by` times) against the counters of the subject keyed
 * `subjectKey` (`RateLimitSubject.key`) at `nowMs`, and resolve to each
 * counter's state after the hits, in the order of `hits`. The worker's adapter is a Durable
 * Object per subject; tests pass an in-memory table.
 */
export type HitRateLimitCounters = (
  subjectKey: string,
  hits: ReadonlyArray<RateLimitIncrement>,
  nowMs: number,
) => Promise<Result<ReadonlyArray<RateLimitCounterState>, RepositoryError>>;
