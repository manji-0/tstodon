import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";
import { AccountId } from "./account-id";
import { ActivityId } from "./activity-id";
import { StatusId } from "./status-id";

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

/** Federate one `Update(Question)` with the poll's current counts (debounced). */
const DistributePollUpdateSchema = z.object({
  kind: z.literal("DistributePollUpdate"),
  pollId: z.string().min(1),
});

/** Send one delivered notification to one of the recipient's push subscriptions. */
const DeliverPushSchema = z.object({
  kind: z.literal("DeliverPush"),
  accountId: z.string().min(1),
  notificationId: z.string().min(1),
  subscriptionId: z.number().int().positive(),
});

/**
 * Move the next page of local follows of a remote actor that moved: those
 * after `afterId` (empty for the first page), to the account it moved to.
 */
const MoveFollowsSchema = z.object({
  kind: z.literal("MoveFollows"),
  fromActorUri: z.url(),
  toActorUri: z.url(),
  afterId: z.string(),
});

/** Whose followers have a home timeline entry: a local account's or a remote actor's. */
const HomeEntryAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("LocalAccount"), accountId: AccountId.schema }),
  z.object({ kind: z.literal("RemoteActor"), actorUri: z.url() }),
]);

/**
 * Tell the next page of the author's local followers (those after
 * `afterAccountId`, empty for the first page) about a home timeline entry
 * (a status, a local reblog, or a remote boost) by its id. `update` and
 * `status.update` reach the followers whose home holds the entry; `delete`
 * reaches every follower, since the entry is gone.
 */
const FanOutHomeSchema = z.object({
  kind: z.literal("FanOutHome"),
  event: z.union([z.literal("update"), z.literal("status.update"), z.literal("delete")]),
  entryId: StatusId.schema,
  author: HomeEntryAuthorSchema,
  afterAccountId: z.string(),
});

export const OutboxJobSchema = z.discriminatedUnion("kind", [
  ExpandFollowersSchema,
  DeliverTargetSchema,
  ProcessExpiredPollsSchema,
  RefreshLinkCardsSchema,
  BackfillRemoteTagsSchema,
  PublishScheduledStatusesSchema,
  ProcessLinkCardSchema,
  DistributePollUpdateSchema,
  DeliverPushSchema,
  MoveFollowsSchema,
  FanOutHomeSchema,
]);

export type OutboxJob = z.infer<typeof OutboxJobSchema>;

export const OutboxJob = {
  schema: OutboxJobSchema,
  parse: schemaResult(OutboxJobSchema),
} as const;
