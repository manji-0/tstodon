import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";
import { ActivityId } from "./activity-id";

const ExpandFollowersSchema = z.object({
  kind: z.literal("ExpandFollowers"),
  activityId: ActivityId.schema,
});
const DeliverTargetSchema = z.object({
  kind: z.literal("DeliverTarget"),
  activityId: ActivityId.schema,
  inboxUrl: z.url(),
});
const ProcessExpiredPollsSchema = unitKind("ProcessExpiredPolls");

export const OutboxJobSchema = z.discriminatedUnion("kind", [
  ExpandFollowersSchema,
  DeliverTargetSchema,
  ProcessExpiredPollsSchema,
]);

export type OutboxJob = z.infer<typeof OutboxJobSchema>;

export const OutboxJob = {
  schema: OutboxJobSchema,
  parse: schemaResult(OutboxJobSchema),
} as const;
