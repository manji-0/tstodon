import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";
import { AccountId } from "./account-id";
import { ActivityId } from "./activity-id";
import { Hostname } from "./hostname";
import { IsoInstant } from "./iso-instant";
import { StatusId } from "./status-id";
import { StatusTargetSchema } from "./status-target";

const ExpandFollowersSchema = z.object({
  kind: z.literal("ExpandFollowers"),
  activityId: ActivityId.schema,
});
/** The local accounts of a forward's audience one `ExpandForward` job reads the followers of. */
export const FORWARD_PAGE_ACCOUNTS = 100;
/**
 * Deliver an inbound activity another server signed, as received (a forward,
 * Mastodon's `ActivityPub::Forwarder`), to the remote followers of the local
 * accounts stored as its audience, leaving out `exceptInboxes`, its actor's
 * own. A job reads a page of `FORWARD_PAGE_ACCOUNTS` accounts, by id after
 * `afterAccountId` (empty for the first), and queues the next page.
 * `targets` counts the inboxes the pages before stored.
 */
const ExpandForwardSchema = z.object({
  kind: z.literal("ExpandForward"),
  activityId: ActivityId.schema,
  afterAccountId: z.string(),
  targets: z.number().int().min(0),
  exceptInboxes: z.array(z.string()),
});
const DeliverTargetSchema = z.object({
  kind: z.literal("DeliverTarget"),
  activityId: ActivityId.schema,
  inboxUrl: z.url(),
});
const ProcessExpiredPollsSchema = unitKind("ProcessExpiredPolls");
/** The poll an `AwaitPollEnd` job waits on: a local one, or a remote status's. */
const EndingPollSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("LocalPoll"), pollId: z.string().min(1) }),
  z.object({ kind: z.literal("RemotePoll"), statusId: z.string().min(1) }),
]);

export type EndingPoll = z.infer<typeof EndingPollSchema>;

/**
 * Run `ProcessExpiredPolls` at `at`, when `poll` ends, as Mastodon's
 * `PollExpirationNotifyWorker.perform_at`. A Queues delay is at most 12
 * hours, so a job queued for later queues itself again until `at`; one whose
 * `at` is no longer the instant queued on the poll stops.
 */
const AwaitPollEndSchema = z.object({
  kind: z.literal("AwaitPollEnd"),
  poll: EndingPollSchema,
  at: z.iso.datetime(),
});
/** Refresh previews whose cache entry has aged out (cron driven). */
const RefreshLinkCardsSchema = unitKind("RefreshLinkCards");
/** Index the tags of the remote statuses stored with `tags_indexed = 0` (cron). */
const BackfillRemoteTagsSchema = unitKind("BackfillRemoteTags");
/**
 * Where recording a block's limits resumes: the last actor recorded, by its
 * account domain's key and its row id.
 */
const DomainBlockLimitsCursorSchema = z.object({
  afterKey: z.string(),
  afterRowId: z.number().int(),
});
/**
 * Bring the limitation the instance domain block `domainBlockId` keeps on the
 * actors cached at or under its domain in line with the block, a page at a
 * time (self-chaining): while the block silences or suspends, record each
 * actor after `cursor`, as Mastodon's `BlockDomainService` sets
 * `silenced_at` / `suspended_at`; once it is a `noop` or removed, delete the
 * rows it left. The block's current severity is what the rows mean, so a
 * change takes effect before the job runs. The block was made or saved: each
 * chain runs as Mastodon's `DomainBlockWorker` does, and its first page
 * forgets the admin's lifts of the block.
 */
const RecordDomainBlockLimitsSchema = z.object({
  kind: z.literal("RecordDomainBlockLimits"),
  domainBlockId: z.string().min(1),
  cursor: DomainBlockLimitsCursorSchema,
});
/**
 * Queue the deletion of the rows each removed or `noop` block left in
 * `remote_actor_domain_limits`, for a `RecordDomainBlockLimits` chain that
 * stopped before it finished (hourly cron).
 */
const ResumeLiftedDomainBlockLimitsSchema = unitKind("ResumeLiftedDomainBlockLimits");
/**
 * Delete the next page of the content a domain suspension's actors had when
 * it was recorded (`remote_actor_content_purges`): what is left is the next
 * page, so the job carries no cursor.
 */
const PurgeSuspendedActorContentSchema = unitKind("PurgeSuspendedActorContent");
/**
 * Delete a batch of media unattached for over a day, rows and objects, as
 * Mastodon's `Vacuum::MediaAttachmentsVacuum` (six-hourly cron, chains while
 * a pass deletes a full batch).
 */
const VacuumMediaAttachmentsSchema = unitKind("VacuumMediaAttachments");
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

/**
 * Finish a stored remote note for one local account its inbox request left
 * to the queue: notify it of the mention (`Mention`), and tell its `direct`
 * stream the conversation changed (`Conversation`), and send it the note's
 * `status` notification (`Status`). A note may reach any number of local
 * accounts; the request serves a fixed number of them.
 */
const FinishRemoteNoteRecipientSchema = z.object({
  kind: z.literal("FinishRemoteNoteRecipient"),
  statusId: z.string().min(1),
  actorUri: z.string().min(1),
  accountId: z.string().min(1),
  steps: z
    .array(z.union([z.literal("Mention"), z.literal("Conversation"), z.literal("Status")]))
    .min(1),
});

/**
 * Send a stored remote note's `status` notification to the next page of its
 * author's notifying followers, those whose follow id sorts after
 * `afterFollowId`, as Mastodon's `FanOutOnWriteService` reads them with
 * `find_in_batches`: a `FinishRemoteNoteRecipient` job for each one the note
 * reaches, and the next page.
 */
const NotifyRemoteNoteFollowersSchema = z.object({
  kind: z.literal("NotifyRemoteNoteFollowers"),
  statusId: z.string().min(1),
  actorUri: z.string().min(1),
  afterFollowId: z.string().min(1),
});

/**
 * Send a local note's `status` notification to its author's notifying
 * followers, as Mastodon's `FanOutOnWriteService` reads them with
 * `find_in_batches` and queues a worker for each. `Page` reads the followers
 * whose follow id sorts after `afterFollowId`, queues a `Follower` job for
 * each one the note reaches and the next page; `Follower` notifies one
 * account.
 */
const NotifyLocalNoteFollowersSchema = z.object({
  kind: z.literal("NotifyLocalNoteFollowers"),
  statusId: StatusId.schema,
  step: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("Page"), afterFollowId: z.string().min(1) }),
    z.object({ kind: z.literal("Follower"), accountId: z.string().min(1) }),
  ]),
});

/**
 * Tell the local accounts that boosted a remote note that it was edited, as
 * Mastodon's `FanOutOnWriteService#notify_about_update!`: an `update`
 * notification from `actorUri` about `statusId`, stored once per account
 * since `since` (the edit's instant). `Page` lists the boosters after
 * `afterAccountId` (empty for the first page), queues a `Booster` job for
 * each and the next page; `Booster` notifies one account.
 */
const NotifyRemoteNoteBoostersSchema = z.object({
  kind: z.literal("NotifyRemoteNoteBoosters"),
  statusId: StatusId.schema,
  actorUri: z.string().min(1),
  since: z.iso.datetime(),
  step: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("Page"), afterAccountId: z.string() }),
    z.object({ kind: z.literal("Booster"), accountId: z.string().min(1) }),
  ]),
});

/**
 * {@link NotifyRemoteNoteBoostersSchema} for a local note: an `update`
 * notification from the note's author, after its edit or the quoted
 * author's `Accept` of its quote.
 */
const NotifyLocalNoteBoostersSchema = z.object({
  kind: z.literal("NotifyLocalNoteBoosters"),
  statusId: StatusId.schema,
  since: z.iso.datetime(),
  step: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("Page"), afterAccountId: z.string() }),
    z.object({ kind: z.literal("Booster"), accountId: z.string().min(1) }),
  ]),
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
 * for the first page).
 */
const MoveFollowsSchema = z.object({
  kind: z.literal("MoveFollows"),
  fromActorUri: z.url(),
  toActorUri: z.url(),
  phase: MovePhaseSchema,
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
 * Sever the follows between a remote actor an admin suspended and the next
 * page of local accounts (by id after `afterAccountId`, empty for the first),
 * recorded under the `account_suspension` severance event `eventId`, and send
 * the actor a `Reject(Follow)` or `Undo(Follow)` for each.
 */
const SeverSuspendedActorFollowsSchema = z.object({
  kind: z.literal("SeverSuspendedActorFollows"),
  actorUri: z.url(),
  eventId: z.string().min(1),
  afterAccountId: z.string(),
});

/**
 * Fetch a remote actor an admin unsuspended again at once, as Mastodon's
 * `UnsuspendAccountService#refresh_remote_account!`.
 */
const RefreshRemoteActorSchema = z.object({
  kind: z.literal("RefreshRemoteActor"),
  actorUri: z.url(),
});

/**
 * Forget a cached remote actor whose server answered 410 for its handle's
 * WebFinger, or for its document on a refresh, as Mastodon's
 * `queue_deletion!` runs an `AccountDeletionWorker`; the same purge as the
 * actor's own `Delete`.
 */
const PurgeRemoteActorSchema = z.object({
  kind: z.literal("PurgeRemoteActor"),
  actorUri: z.url(),
});

/**
 * Queue a fresh `SeverSuspendedActorFollows` for each actor suspended over an
 * hour ago that still has follows with local accounts (hourly cron).
 */
const ResumeSuspendedActorSeverancesSchema = unitKind("ResumeSuspendedActorSeverances");

/**
 * Send the next page of the `Reject(Follow)` and `Undo(Follow)` notices a
 * domain suspension stored (`severance_notices`): the notices still unsent
 * are the next page, so the job carries no cursor.
 */
const SendSeveranceNoticesSchema = unitKind("SendSeveranceNotices");

/**
 * Accept the next page of a local account's pending follow requests after it
 * was unlocked (Mastodon's `AuthorizeFollowWorker`s): those still pending are
 * the next page, so the job carries no cursor.
 */
const AuthorizeFollowRequestsSchema = z.object({
  kind: z.literal("AuthorizeFollowRequests"),
  accountId: AccountId.schema,
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

/**
 * Fetch the parent of the stored remote reply `statusId`, which this server
 * did not hold when the reply arrived, and finish the reply as linked, as
 * Mastodon's `ThreadResolveWorker`. `hop` counts the statuses this chain of
 * jobs fetches, the reply's parent being 1: a fetched parent that is itself a
 * reply to a status not held queues the next hop, up to Mastodon's
 * `DISCOVERIES_PER_REQUEST`.
 */
const ResolveRemoteThreadSchema = z.object({
  kind: z.literal("ResolveRemoteThread"),
  statusId: StatusId.schema,
  hop: z.number().int().min(1),
});

/**
 * Store the notes above a cached remote status in its thread (`Root`), then
 * walk its reply tree one level at a time (`Level`): the cached statuses
 * `depth` levels below it (0 is the status itself), after the one with id
 * `after`, each expanded by its own `replies` collection. `startedAt` is when
 * the first pass began: a status cached since was stored by the walk.
 * `resume` names the status whose list an earlier job stopped in: where the
 * list is read from (the note, or the page an earlier job reached, after
 * `itemsBefore` listed replies), and how many of the replies read from there
 * that job already went through. `visited` counts the statuses of the tree
 * the walk reached (expanded or skipped), `listed` and `pages` the replies
 * listed and the collection pages read so far, and `stored` the statuses
 * stored, for the whole tree.
 */
const BackfillRemoteThreadSchema = z.object({
  kind: z.literal("BackfillRemoteThread"),
  statusId: StatusId.schema,
  from: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("Root") }),
      z.object({
        kind: z.literal("Level"),
        startedAt: IsoInstant.schema,
        depth: z.number().int().nonnegative(),
        after: z.string(),
        resume: z
          .object({
            id: StatusId.schema,
            reading: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("Note") }),
              z.object({
                kind: z.literal("Page"),
                uri: z.url(),
                itemsBefore: z.number().int().nonnegative(),
              }),
            ]),
            offset: z.number().int().nonnegative(),
          })
          .optional(),
        visited: z.number().int().nonnegative(),
        listed: z.number().int().nonnegative(),
        pages: z.number().int().nonnegative(),
        stored: z.number().int().nonnegative(),
      }),
    ])
    .default({ kind: "Root" }),
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

/**
 * Read the remote actor's partial followers collection at `url` and drop the
 * local follows of it that it no longer lists (FEP-8fcf), as Mastodon's
 * `FollowersSynchronizationWorker`. `digest` is the one its
 * `Collection-Synchronization` header named, if any.
 */
const SynchronizeFollowersSchema = z.object({
  kind: z.literal("SynchronizeFollowers"),
  actorUri: z.url(),
  url: z.string().min(1),
  digest: z.string().optional(),
});

/**
 * Process one item of the stored remote collection `collectionId`, as
 * Mastodon's `ProcessFeaturedItemWorker`: the item's document as the
 * collection embedded it, or its id to fetch, at `position` in the
 * collection's order (none for an item added on its own, which goes last).
 */
const ProcessFeaturedItemSchema = z.object({
  kind: z.literal("ProcessFeaturedItem"),
  collectionId: z.string().min(1),
  item: z.union([z.string().min(1), z.record(z.string(), z.json())]),
  position: z.number().int().min(1).optional(),
});

/**
 * Check the authorization `approvalUri` of the remote collection item
 * `itemId` again, as Mastodon's `VerifyFeaturedItemWorker`, after its server
 * could not be reached `attempt` times.
 */
const VerifyFeaturedItemSchema = z.object({
  kind: z.literal("VerifyFeaturedItem"),
  itemId: z.string().min(1),
  approvalUri: z.string().min(1),
  attempt: z.number().int().min(1),
});

/**
 * Read the remote actor `actorUri`'s `featuredCollections`, as Mastodon's
 * `SynchronizeFeaturedCollectionsCollectionWorker`, which each processing
 * of the actor queues.
 */
const SynchronizeRemoteCollectionsSchema = z.object({
  kind: z.literal("SynchronizeRemoteCollections"),
  actorUri: z.string().min(1),
});

/**
 * Tag the collection `uri` names on `status` once it is stored, as
 * Mastodon's `TaggedCollectionResolveWorker`: a remote note's
 * `FeaturedCollection` tag not stored yet (`lookup: "Uri"`, a document that
 * must name itself), or a local post's link to a known server
 * (`ProcessLinksService` through `ResolveURLService`; `lookup: "Url"`, a
 * page that may name its document).
 */
const ResolveTaggedCollectionSchema = z.object({
  kind: z.literal("ResolveTaggedCollection"),
  status: StatusTargetSchema,
  uri: z.url(),
  lookup: z.literal(["Uri", "Url"]),
});

/**
 * Check the links of an account's profile fields, as Mastodon's
 * `VerifyAccountLinksWorker`: each field from `fromIndex` on whose link waits
 * for a check is marked verified when the linked page links back with
 * `rel="me"`. A job checks a few fields and queues the rest from the next index.
 */
const VerifyProfileLinksSchema = z.object({
  kind: z.literal("VerifyProfileLinks"),
  account: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("LocalAccount"), accountId: z.string().min(1) }),
    z.object({ kind: z.literal("RemoteActor"), actorUri: z.url() }),
  ]),
  fromIndex: z.number().int().min(0).default(0),
});

/**
 * Send the activities local statuses still owe remote servers, those whose
 * retry is due (`PendingStatusFederation`), a page at a time.
 */
const FederatePendingStatusesSchema = z.object({
  kind: z.literal("FederatePendingStatuses"),
});

export const OutboxJobSchema = z.discriminatedUnion("kind", [
  ExpandFollowersSchema,
  ExpandForwardSchema,
  DeliverTargetSchema,
  ProcessExpiredPollsSchema,
  AwaitPollEndSchema,
  RefreshLinkCardsSchema,
  BackfillRemoteTagsSchema,
  RecordDomainBlockLimitsSchema,
  ResumeLiftedDomainBlockLimitsSchema,
  PurgeSuspendedActorContentSchema,
  VacuumMediaAttachmentsSchema,
  VacuumActivitiesSchema,
  RequeueDeadOutboxJobsSchema,
  RotateActorKeysSchema,
  PublishScheduledStatusesSchema,
  CleanUpStatusesSchema,
  CleanUpAccountStatusesSchema,
  ProcessLinkCardSchema,
  FinishRemoteNoteRecipientSchema,
  NotifyRemoteNoteFollowersSchema,
  NotifyLocalNoteFollowersSchema,
  NotifyRemoteNoteBoostersSchema,
  NotifyLocalNoteBoostersSchema,
  DistributePollUpdateSchema,
  DeliverPushSchema,
  MoveFollowsSchema,
  FanOutHomeSchema,
  FanOutRemovedStatusesSchema,
  FanOutPublicSchema,
  BackfillRemoteOutboxSchema,
  BackfillRemoteThreadSchema,
  ResolveRemoteThreadSchema,
  ProcessCsvImportSchema,
  SeverBlockedDomainFollowsSchema,
  AuthorizeFollowRequestsSchema,
  SeverSuspendedActorFollowsSchema,
  ResumeSuspendedActorSeverancesSchema,
  RefreshRemoteActorSchema,
  PurgeRemoteActorSchema,
  SendSeveranceNoticesSchema,
  RefetchAndVerifyQuoteSchema,
  RefreshQuoteSchema,
  FederatePendingStatusesSchema,
  VerifyProfileLinksSchema,
  SynchronizeFollowersSchema,
  ProcessFeaturedItemSchema,
  VerifyFeaturedItemSchema,
  SynchronizeRemoteCollectionsSchema,
  ResolveTaggedCollectionSchema,
]);

export type OutboxJob = z.infer<typeof OutboxJobSchema>;

export const OutboxJob = {
  schema: OutboxJobSchema,
  parse: schemaResult(OutboxJobSchema),
} as const;
