import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";
import { AccountId } from "./account-id";
import { ActivityId } from "./activity-id";
import { Hostname } from "./hostname";
import { IsoInstant } from "./iso-instant";
import { StatusId } from "./status-id";
import { StoredMediaMetadata } from "./stored-media-metadata";
import { StoredMediaSizes } from "./stored-media-sizes";

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
 * Index the next page of stored local notes under their tags and store the
 * tag names, from the `local_status_tags` cursor (cron, self-chaining, stops once complete).
 */
const BackfillLocalNoteTagsSchema = unitKind("BackfillLocalNoteTags");
/**
 * Move the next batch of attachments after `afterId` (empty for the first)
 * that are still at an id-derived key to a random key (cron, self-chaining).
 */
const RekeyLegacyMediaSchema = z.object({
  kind: z.literal("RekeyLegacyMedia"),
  afterId: z.string(),
});
/**
 * Delete a batch of media unattached for over a day, rows and objects, as
 * Mastodon's `Vacuum::MediaAttachmentsVacuum` (six-hourly cron, chains while
 * a pass deletes a full batch).
 */
const VacuumMediaAttachmentsSchema = unitKind("VacuumMediaAttachments");
/**
 * Strip the metadata from the next page of media stored before stripping on
 * upload, in place (see `StoredMediaMetadata`): the rows of `source` after
 * `afterId` (empty for the first), then the next source. `tally` sums the
 * pages before, for the log line of the last one. The six-hourly cron queues
 * the first page; a page with work after it queues the next.
 */
const StripStoredMediaMetadataSchema = z.object({
  kind: z.literal("StripStoredMediaMetadata"),
  source: StoredMediaMetadata.sourceSchema.default("attachments"),
  afterId: z.string().default(""),
  tally: StoredMediaMetadata.tallySchema.default(StoredMediaMetadata.emptyTally),
});
/**
 * Record the byte size of the next page of stored objects whose size is not
 * known (stored before sizes were recorded; see `StoredMediaSizes`), from a
 * HEAD of each: the rows of `source` after `afterId` (empty for the first),
 * then the later sources. `tally` sums the pages before, for the log line of
 * the last one. The six-hourly cron queues the first page; a full page
 * queues the next.
 */
const BackfillStoredMediaSizesSchema = z.object({
  kind: z.literal("BackfillStoredMediaSizes"),
  source: StoredMediaSizes.sourceSchema.default("attachments"),
  afterId: z.string().default(""),
  tally: StoredMediaSizes.tallySchema.default(StoredMediaSizes.emptyTally),
});
/**
 * Delete the outbox and inbox rows past their retention, one bounded batch
 * per table (see `ActivityVacuum`); six-hourly cron, chains while a table
 * fills its batch.
 */
const VacuumActivitiesSchema = unitKind("VacuumActivities");

/** A SHA-256 hex digest: the id of an `outbox_dead_jobs` row. */
export const DeadOutboxJobIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Which dead-lettered jobs `RequeueDeadOutboxJobs` sends back. */
export const DeadOutboxJobSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("All") }),
  z.object({ kind: z.literal("JobKind"), jobKind: z.string().min(1) }),
  z.object({ kind: z.literal("Ids"), ids: z.array(DeadOutboxJobIdSchema).min(1).max(100) }),
]);

export type DeadOutboxJobSelection = z.infer<typeof DeadOutboxJobSelectionSchema>;

/**
 * Send the stored dead-lettered jobs that `select` names back to the outbox
 * queue and delete their rows, a page at a time (operator sent, see the
 * runbook). `before` is when the first page ran (empty for the first page):
 * a job that dies again after that is left for the next requeue, so a job
 * that keeps failing is not sent round in the same run.
 */
const RequeueDeadOutboxJobsSchema = z.object({
  kind: z.literal("RequeueDeadOutboxJobs"),
  select: DeadOutboxJobSelectionSchema,
  before: z.string().default(""),
});
/**
 * Replace the key pairs of the next page of local accounts (by id after
 * `afterId`, empty for the first page) not rotated since `startedAt`, and
 * send each one's followers an actor `Update` (admin sent: the actor keys
 * page or `POST /api/v1/admin/actor_keys/rotate_all`; see the runbook's key
 * compromise playbook). The first page also rotates the instance actor's
 * pair. A full page queues the next one after a pause, so the `Update`s
 * reach remote servers paced. `rotated` counts the accounts of the pages
 * before, for the log line of the last one.
 */
const RotateActorKeysSchema = z.object({
  kind: z.literal("RotateActorKeys"),
  startedAt: IsoInstant.schema,
  afterId: z.string().default(""),
  rotated: z.number().int().min(0).default(0),
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
 * Remove the next page of an account's follows, requests, and notifications
 * with a domain it blocked: the actors on `domain` after `afterActorUri` in
 * URI order. The accepted follows are recorded under the `user_domain_block`
 * severance event `eventId`, which the last page closes and notifies.
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

/**
 * Check a pending quote by a remote note again after its quoted note or
 * stamp could not be fetched, as Mastodon's `RefetchAndVerifyQuoteWorker`:
 * `quotedUri` is the quoted note and `approvalUri` the stamp the note named,
 * `attempt` counts from 1 (see `QuoteRetry`).
 */
const RefetchAndVerifyQuoteSchema = z.object({
  kind: z.literal("RefetchAndVerifyQuote"),
  quoteId: z.string().min(1),
  quotedUri: z.url(),
  approvalUri: z.url().optional(),
  attempt: z.number().int().min(1),
});

/**
 * Fetch the stamp of an accepted quote of a remote status again, as
 * Mastodon's `QuoteRefreshWorker`; one that no longer resolves revokes it.
 */
const RefreshQuoteSchema = z.object({
  kind: z.literal("RefreshQuote"),
  quoteId: z.string().min(1),
});

export const OutboxJobSchema = z.discriminatedUnion("kind", [
  ExpandFollowersSchema,
  DeliverTargetSchema,
  ProcessExpiredPollsSchema,
  RefreshLinkCardsSchema,
  BackfillRemoteTagsSchema,
  BackfillLocalNoteTagsSchema,
  RekeyLegacyMediaSchema,
  VacuumMediaAttachmentsSchema,
  VacuumActivitiesSchema,
  RequeueDeadOutboxJobsSchema,
  RotateActorKeysSchema,
  StripStoredMediaMetadataSchema,
  BackfillStoredMediaSizesSchema,
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
  RefetchAndVerifyQuoteSchema,
  RefreshQuoteSchema,
]);

export type OutboxJob = z.infer<typeof OutboxJobSchema>;

export const OutboxJob = {
  schema: OutboxJobSchema,
  parse: schemaResult(OutboxJobSchema),
} as const;
