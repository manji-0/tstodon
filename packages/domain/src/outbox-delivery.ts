import { assertNever, schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";
import {
  DeliveryAttemptOutcome,
  type DeliveryAttemptOutcome as DeliveryAttemptOutcomeType,
} from "./delivery-attempt-outcome";

/** One attempt and Mastodon's 16 retries (`ActivityPub::DeliveryWorker`, `retry: 16`). */
export const DELIVERY_MAX_ATTEMPTS = 17;

/** A `Retry-After` longer than this (12 hours) is shortened to it. */
export const RETRY_AFTER_CAP_SECONDS = 12 * 60 * 60;

/**
 * A target still `Queued` this long (10 days) after it was created is given up
 * by the stuck-delivery sweep: the retries take about 2.1 days, and even a
 * remote asking for the longest `Retry-After` each time is done well before.
 */
export const DELIVERY_GIVE_UP_AFTER_MS = 10 * 24 * 60 * 60 * 1000;

const QueuedSchema = z.object({
  kind: z.literal("Queued"),
  attemptCount: z.number().int().nonnegative(),
});
const ExpandedSchema = unitKind("Expanded");
const DeliveredSchema = unitKind("Delivered");
const RetryExhaustedSchema = z.object({
  kind: z.literal("Failed"),
  reasonKind: z.literal("RetryExhausted"),
  attemptCount: z.number().int().positive(),
});
const PermanentSchema = z.object({
  kind: z.literal("Failed"),
  reasonKind: z.literal("Permanent"),
  httpStatus: z.number().int(),
});

const DomainUnavailableSchema = z.object({
  kind: z.literal("Skipped"),
  reasonKind: z.literal("DomainUnavailable"),
});

/** A target that was never attempted. */
export const OutboxDeliverySkippedSchema = z.discriminatedUnion("reasonKind", [
  DomainUnavailableSchema,
]);

export const OutboxDeliveryFailedSchema = z.discriminatedUnion("reasonKind", [
  RetryExhaustedSchema,
  PermanentSchema,
]);

export const OutboxDeliverySchema = z.discriminatedUnion("kind", [
  QueuedSchema,
  ExpandedSchema,
  DeliveredSchema,
  OutboxDeliveryFailedSchema,
  OutboxDeliverySkippedSchema,
]);

export type OutboxDelivery = z.infer<typeof OutboxDeliverySchema>;
export type QueuedOutboxDelivery = z.infer<typeof QueuedSchema>;

export const OutboxDelivery = {
  schema: OutboxDeliverySchema,
  parse: schemaResult(OutboxDeliverySchema),
  queued: (): QueuedOutboxDelivery => ({ kind: "Queued", attemptCount: 0 }),
  afterExpand: (followerTargetCount: number): OutboxDelivery =>
    followerTargetCount === 0 ? { kind: "Delivered" } : { kind: "Expanded" },
  afterAttempt: (current: OutboxDelivery, outcome: DeliveryAttemptOutcomeType): OutboxDelivery => {
    if (current.kind !== "Queued") {
      return current;
    }
    switch (outcome.kind) {
      case "Success":
        return { kind: "Delivered" };
      case "PermanentFailure":
        return {
          kind: "Failed",
          reasonKind: "Permanent",
          httpStatus: outcome.httpStatus,
        };
      case "TransientFailure": {
        const nextAttempt = current.attemptCount + 1;
        if (nextAttempt >= DELIVERY_MAX_ATTEMPTS) {
          return {
            kind: "Failed",
            reasonKind: "RetryExhausted",
            attemptCount: nextAttempt,
          };
        }
        return { kind: "Queued", attemptCount: nextAttempt };
      }
      default:
        return assertNever(outcome);
    }
  },
  /** A target left out because its domain is unavailable (`DeliveryDomainHealth`). */
  skipped: (): OutboxDelivery => ({ kind: "Skipped", reasonKind: "DomainUnavailable" }),
  /**
   * Sidekiq's default retry delay, which Mastodon's `ActivityPub::DeliveryWorker`
   * (`retry: 16`) uses: `count⁴ + 15 + rand(10) × (count + 1)` seconds before
   * retry `count` (0 for the first). `random` is in [0, 1).
   */
  backoffMs: (retryCount: number, random: number): number => {
    const jitter = Math.min(9, Math.floor(random * 10));
    return (retryCount ** 4 + 15 + jitter * (retryCount + 1)) * 1000;
  },
  /**
   * How long to wait after the attempt that left `next` queued: the backoff
   * for its retry, or the remote's `Retry-After` when that is longer (capped
   * at {@link RETRY_AFTER_CAP_SECONDS}).
   */
  nextDelayMs: (
    next: QueuedOutboxDelivery,
    outcome: DeliveryAttemptOutcomeType,
    random: number,
  ): number => {
    const backoff = OutboxDelivery.backoffMs(Math.max(0, next.attemptCount - 1), random);
    if (outcome.kind !== "TransientFailure" || outcome.cause.kind !== "Throttled") {
      return backoff;
    }
    const asked = Math.min(outcome.cause.retryAfterSeconds, RETRY_AFTER_CAP_SECONDS) * 1000;
    return Math.max(backoff, asked);
  },
} as const;

export { DeliveryAttemptOutcome };
