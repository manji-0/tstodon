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
/** Queue one `CleanUpAccountStatuses` per account with automated post deletion on (cron). */
const CleanUpStatusesSchema = unitKind("CleanUpStatuses");
/** Delete the next bounded batch of one account's posts that its cleanup policy removes. */
const CleanUpAccountStatusesSchema = z.object({
  kind: z.literal("CleanUpAccountStatuses"),
  accountId: AccountId.schema,
});
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
 * What an account that moved carries over to the account it moved to, in the
 * order it is done: the local follows (with the list memberships that ride on
 * them), then the notes, blocks and mutes of local accounts.
 */
const MovePhaseSchema = z.union([
  z.literal("follows"),
  z.literal("notes"),
  z.literal("blocks"),
  z.literal("mutes"),
]);

export type MovePhase = z.infer<typeof MovePhaseSchema>;

/**
 * Carry the next page of an account that moved, local or remote, to the
 * account it moved to: the local accounts of `phase` after `afterId` (empty
 * for the first page). A job queued before phases existed moves follows.
 */
const MoveFollowsSchema = z.object({
  kind: z.literal("MoveFollows"),
  fromActorUri: z.url(),
  toActorUri: z.url(),
  phase: MovePhaseSchema.default("follows"),
  afterId: z.string(),
});

/** Store the recent public notes and boosts in a remote actor's outbox, and its pinned notes. */
const BackfillRemoteOutboxSchema = z.object({
  kind: z.literal("BackfillRemoteOutbox"),
  actorUri: z.url(),
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

/**
 * Tell the next page of stream hubs (those after `afterHub`, empty for the
 * first page) with public or hashtag subscriptions about a public status by
 * its id. `update` and `status.update` reach the subscriptions whose
 * timeline holds the status for the hub's viewer; `delete` reaches every
 * public and hashtag subscription, since the status and its tags are gone.
 */
const FanOutPublicSchema = z.object({
  kind: z.literal("FanOutPublic"),
  event: z.union([z.literal("update"), z.literal("status.update"), z.literal("delete")]),
  entryId: StatusId.schema,
  afterHub: z.string(),
});

export const OutboxJobSchema = z.discriminatedUnion("kind", [
  ExpandFollowersSchema,
  DeliverTargetSchema,
  ProcessExpiredPollsSchema,
  RefreshLinkCardsSchema,
  BackfillRemoteTagsSchema,
  PublishScheduledStatusesSchema,
  CleanUpStatusesSchema,
  CleanUpAccountStatusesSchema,
  ProcessLinkCardSchema,
  DistributePollUpdateSchema,
  DeliverPushSchema,
  MoveFollowsSchema,
  FanOutHomeSchema,
  FanOutPublicSchema,
  BackfillRemoteOutboxSchema,
]);

export type OutboxJob = z.infer<typeof OutboxJobSchema>;

export const OutboxJob = {
  schema: OutboxJobSchema,
  parse: schemaResult(OutboxJobSchema),
} as const;
