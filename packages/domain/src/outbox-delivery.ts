import { assertNever, schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";
import {
  DeliveryAttemptOutcome,
  type DeliveryAttemptOutcome as DeliveryAttemptOutcomeType,
} from "./delivery-attempt-outcome";

export const DELIVERY_MAX_ATTEMPTS = 5;

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

export const OutboxDeliveryFailedSchema = z.discriminatedUnion("reasonKind", [
  RetryExhaustedSchema,
  PermanentSchema,
]);

export const OutboxDeliverySchema = z.discriminatedUnion("kind", [
  QueuedSchema,
  ExpandedSchema,
  DeliveredSchema,
  OutboxDeliveryFailedSchema,
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
    }
  },
  retryDelay: (attempt: number): "+1 minute" | "+5 minutes" | "+15 minutes" | "+60 minutes" => {
    switch (attempt) {
      case 1:
        return "+1 minute";
      case 2:
        return "+5 minutes";
      case 3:
        return "+15 minutes";
      default:
        return "+60 minutes";
    }
  },
  workflowSleep: (attempt: number): "1 minute" | "5 minutes" | "15 minutes" | "60 minutes" => {
    const delay = OutboxDelivery.retryDelay(attempt);
    switch (delay) {
      case "+1 minute":
        return "1 minute";
      case "+5 minutes":
        return "5 minutes";
      case "+15 minutes":
        return "15 minutes";
      case "+60 minutes":
        return "60 minutes";
      default:
        return assertNever(delay);
    }
  },
} as const;

export { DeliveryAttemptOutcome };
