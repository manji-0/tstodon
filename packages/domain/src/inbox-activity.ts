import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";
import { Activity, ActivitySchema } from "./activity";
import { ActivityId } from "./activity-id";

const InvalidSignatureSchema = unitKind("InvalidSignature");
const UnknownTypeSchema = z.object({
  kind: z.literal("UnknownType"),
  type: z.string().min(1),
});
const TargetNotFoundSchema = unitKind("TargetNotFound");

export const InboxRejectErrorSchema = z.discriminatedUnion("kind", [
  InvalidSignatureSchema,
  UnknownTypeSchema,
  TargetNotFoundSchema,
]);

export type InboxRejectError = z.infer<typeof InboxRejectErrorSchema>;

/**
 * Whether a delivery holds the claim on its activity id. The inbox claims
 * the id before applying the activity and marks it handled only after, so
 * an apply that fails gives the id back for the sender's retry.
 */
const InboxClaimSchema = z.discriminatedUnion("kind", [
  /** This delivery applies the activity: a new id, or a claim left stale by an apply cut off. */
  unitKind("Acquired"),
  /** Another delivery is applying it now. */
  unitKind("InFlight"),
  /** It was applied or rejected before. */
  unitKind("Processed"),
]);

export type InboxClaim = z.infer<typeof InboxClaimSchema>;

/**
 * How long a claim may stay unfinished before another delivery may take it
 * over: well past how long an apply runs, so a live apply keeps its claim.
 */
const CLAIM_STALE_AFTER_MS = 15 * 60 * 1000;

export const InboxClaim = {
  schema: InboxClaimSchema,
  /** Claims made before this instant are stale. */
  staleBefore: (nowMs: number): string => new Date(nowMs - CLAIM_STALE_AFTER_MS).toISOString(),
} as const;

const ReceivedSchema = z.object({
  kind: z.literal("Received"),
  activityId: ActivityId.schema,
  payload: z.unknown(),
});
const DuplicateSchema = z.object({
  kind: z.literal("Duplicate"),
  activityId: ActivityId.schema,
  claim: z.discriminatedUnion("kind", [unitKind("InFlight"), unitKind("Processed")]),
});
const DispatchedSchema = z.object({
  kind: z.literal("Dispatched"),
  activity: ActivitySchema,
});
const RejectedSchema = z.object({
  kind: z.literal("Rejected"),
  activityId: ActivityId.schema,
  error: InboxRejectErrorSchema,
});

export const InboxActivitySchema = z.discriminatedUnion("kind", [
  ReceivedSchema,
  DuplicateSchema,
  DispatchedSchema,
  RejectedSchema,
]);

export type InboxActivity = z.infer<typeof InboxActivitySchema>;

export const InboxActivity = {
  schema: InboxActivitySchema,
  parse: schemaResult(InboxActivitySchema),
  dispatch: (
    received: z.infer<typeof ReceivedSchema>,
    claim: InboxClaim,
  ): Exclude<InboxActivity, { kind: "Received" }> => {
    if (claim.kind !== "Acquired") {
      return { kind: "Duplicate", activityId: received.activityId, claim };
    }
    const parsed = Activity.parse(received.payload);
    if (parsed.isErr()) {
      return {
        kind: "Rejected",
        activityId: received.activityId,
        error: { kind: "UnknownType", type: "unparsed" },
      };
    }
    return { kind: "Dispatched", activity: parsed.value };
  },
} as const;
