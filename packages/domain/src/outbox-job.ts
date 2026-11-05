import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";
import { AccountId } from "./account-id";
import { ActivityId } from "./activity-id";
import { Hostname } from "./hostname";
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
/**
 * Move the next batch of attachments after `afterId` (empty for the first)
 * that are still at an id-derived key to a random key (cron, self-chaining).
 */
const RekeyLegacyMediaSchema = z.object({
  kind: z.literal("RekeyLegacyMedia"),
  afterId: z.string(),
});
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

/**
 * Run the next page of a data import (see `csv-import.ts`): apply the next
 * pending rows after `afterPosition`, or, in an overwrite, remove the next
 * page of entries (after `afterCursor`) that the file does not name.
 */
const ProcessCsvImportSchema = z.object({
  kind: z.literal("ProcessCsvImport"),
  importId: z.string().min(1),
  step: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("Rows"), afterPosition: z.number().int().min(0) }),
    z.object({ kind: z.literal("Prune"), afterCursor: z.string() }),
  ]),
});

/**
 * Remove the next page of an account's follows with a domain it blocked: the
 * actors on `domain` after `afterActorUri` in URI order. The follows are
 * recorded under the `user_domain_block` severance event `eventId`, which the
 * last page closes and notifies.
 */
const SeverBlockedDomainFollowsSchema = z.object({
  kind: z.literal("SeverBlockedDomainFollows"),
  accountId: AccountId.schema,
  domain: Hostname.schema,
  eventId: z.string().min(1),
  afterActorUri: z.string(),
});

/**
 * Store the recent public notes and boosts in a remote actor's outbox, and its
 * pinned notes. `from` says which page: the collection's first (`Start`, which
 * also reads the pins), or a later one an earlier job found by following
 * `next`, `depth` pages in.
 */
const BackfillRemoteOutboxSchema = z.object({
  kind: z.literal("BackfillRemoteOutbox"),
  actorUri: z.url(),
  from: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("Start") }),
      z.object({ kind: z.literal("Page"), pageUri: z.url(), depth: z.number().int().min(1) }),
    ])
    .default({ kind: "Start" }),
});

/** Store the notes above a cached remote status in its thread, and the replies it lists. */
const BackfillRemoteThreadSchema = z.object({
  kind: z.literal("BackfillRemoteThread"),
  statusId: StatusId.schema,
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
 * Tell the listed local accounts that the listed home timeline entries are
 * gone with `delete`. Used when the entries' author was purged: its followers
 * are listed up front, since the follows are gone with it.
 */
const FanOutRemovedStatusesSchema = z.object({
  kind: z.literal("FanOutRemovedStatuses"),
  accountIds: z.array(AccountId.schema).min(1).max(20),
  statusIds: z.array(StatusId.schema).min(1).max(20),
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
  RekeyLegacyMediaSchema,
  PublishScheduledStatusesSchema,
  CleanUpStatusesSchema,
  CleanUpAccountStatusesSchema,
  ProcessLinkCardSchema,
  DistributePollUpdateSchema,
  DeliverPushSchema,
  MoveFollowsSchema,
  FanOutHomeSchema,
  FanOutRemovedStatusesSchema,
  FanOutPublicSchema,
  BackfillRemoteOutboxSchema,
  BackfillRemoteThreadSchema,
  ProcessCsvImportSchema,
  SeverBlockedDomainFollowsSchema,
]);

export type OutboxJob = z.infer<typeof OutboxJobSchema>;

export const OutboxJob = {
  schema: OutboxJobSchema,
  parse: schemaResult(OutboxJobSchema),
} as const;
