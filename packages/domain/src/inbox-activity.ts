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

const ReceivedSchema = z.object({
  kind: z.literal("Received"),
  activityId: ActivityId.schema,
  payload: z.unknown(),
});
const DuplicateSchema = z.object({
  kind: z.literal("Duplicate"),
  activityId: ActivityId.schema,
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
    knownIds: ReadonlySet<string>,
  ): InboxActivity => {
    if (knownIds.has(received.activityId)) {
      return { kind: "Duplicate", activityId: received.activityId };
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
