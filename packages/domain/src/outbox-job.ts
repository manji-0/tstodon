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
/** Refresh previews whose cache entry has aged out (cron driven). */
const RefreshLinkCardsSchema = unitKind("RefreshLinkCards");
/** Index the tags of remote statuses written before the tag index (cron). */
const BackfillRemoteTagsSchema = unitKind("BackfillRemoteTags");
/** Publish the scheduled statuses whose time has come (cron). */
const PublishScheduledStatusesSchema = unitKind("PublishScheduledStatuses");
/** Build the link preview for a stored status or remote status. */
const ProcessLinkCardSchema = z.object({
  kind: z.literal("ProcessLinkCard"),
  target: z.union([z.literal("Status"), z.literal("RemoteStatus")]),
  id: z.string().min(1),
  url: z.url(),
});

/** Send one delivered notification to one of the recipient's push subscriptions. */
const DeliverPushSchema = z.object({
  kind: z.literal("DeliverPush"),
  accountId: z.string().min(1),
  notificationId: z.string().min(1),
  subscriptionId: z.number().int().positive(),
});

export const OutboxJobSchema = z.discriminatedUnion("kind", [
  ExpandFollowersSchema,
  DeliverTargetSchema,
  ProcessExpiredPollsSchema,
  RefreshLinkCardsSchema,
  BackfillRemoteTagsSchema,
  PublishScheduledStatusesSchema,
  ProcessLinkCardSchema,
  DeliverPushSchema,
]);

export type OutboxJob = z.infer<typeof OutboxJobSchema>;

export const OutboxJob = {
  schema: OutboxJobSchema,
  parse: schemaResult(OutboxJobSchema),
} as const;
