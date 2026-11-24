import {
  InstanceIdentity,
  IsoInstant,
  RealtimeWindow,
  RemoteActor,
  type RemoteStatus as RemoteStatusValue,
  Visibility,
  type MentionedPost,
  NoteThread,
  type OutboxJob,
  StatusNotificationAudience,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { CreateDocumentSchema, refId } from "./activitypub-wire";
import { recordNoteEmojis } from "./remote-emoji-record";
import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { forwardRemoteActivity, type ReceivedActivity } from "./activity-forward";
import { signedInRecentlySince } from "./account-activity";
import { nowInstant } from "./clock";
import { readableRow, type RepositoryError } from "./d1";
import { parseInstanceIdentity } from "./runtime-config";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { resolveRemoteActor } from "./remote-actor-fetch";
import { findRemoteActorByUri, findRemoteActorsByUris } from "./remote-actor-store";
import type { IdClock } from "./ids";
import { noteReplyTo, parseLocalActorUsername, parseLocalStatusId } from "./activitypub";
import { findAccountsByUsernames } from "./account-store";
import { startLinkCard } from "./link-card";
import { mentionedPost, notifyFromRemoteOnce } from "./notify";
import { startHomeFanOut } from "./home-fan-out";
import { startPublicFanOut } from "./public-fan-out";
import {
  applyMediaPolicy,
  noteCardUrl,
  noteFromUnknown,
  noteHashtags,
  parseNoteDocument,
} from "./remote-note-document";
import {
  claimOwed,
  clearOwed,
  type HeldOwed,
  type OwedMarker,
  listOwed,
  newOwedMarker,
  owedStatement,
  releaseOwed,
} from "./remote-status-owed";
import { findThreadParent } from "./thread-context";
import {
  fetchableParent,
  queueRemoteThreadResolve,
  type ThreadResolve,
} from "./remote-thread-resolve";
import type { JobStart } from "./inline-job";
import { findRemoteStatusReplyTargets } from "./remote-reply-store";
import { settleInvalidRemoteStatus } from "./remote-status-heal";
import {
  findDeliveredRemoteStatus,
  findRemoteStatusesByIds,
  type InvalidRemoteStatusRow,
  type KnownRemoteStatus,
  upsertRemoteStatus,
} from "./remote-status-store";
import { publishConversationUpdate } from "./conversation-stream";
import {
  listActiveRemoteStatusMentionAccountIds,
  listRemoteStatusMentions,
  listShownRemoteStatusMentions,
  recordRemoteStatusMentions,
} from "./mention-store";
import { measureJobPage } from "./metrics";
import { notifyRemoteNoteBoosters } from "./remote-note-booster-updates";
import { isNotifyingRemoteFollower, notifyingRemoteFollowersPage } from "./outbound-follow-store";
import { queueOutboxJobs } from "./queue-jobs";
import { stringList } from "./form-values";
import { type EmbeddedQuoted, type RemoteQuoteContext, syncRemoteQuote } from "./remote-quote";

const MentionTagsSchema = z.object({
  tag: z
    .array(z.object({ type: z.string().optional(), href: z.string().optional() }).passthrough())
    .optional(),
});

/**
 * How many of the local accounts a remote note names its inbox request
 * notifies, or tells about the conversation; the rest are left to queued
 * `FinishRemoteNoteRecipient` jobs. Mastodon works through every one in
 * Sidekiq. Here a mention notification costs about 40 D1 queries (the
 * policy checks and the streamed document), and so does the conversation of
 * an account with its `direct` stream open, so 8 keeps the request under
 * D1's 1000 queries per Worker invocation (`remote-note-recipients.test.ts`
 * measures it). Every account the note names can read it: those rows are
 * written for all of them, in one batch.
 */
export const INLINE_NOTE_RECIPIENTS = 8;

/**
 * Notifying followers of a note's author read at a time, as Mastodon's
 * `find_in_batches` reads them: the inbox request reads the first page, and
 * a `NotifyRemoteNoteFollowers` job each later one, so what one invocation
 * reads and queues stays flat with the number of followers.
 */
export const NOTIFYING_FOLLOWER_PAGE_SIZE = 50;

/** The `href` of each `Mention` tag of a note document, each once. */
const mentionHrefs = (raw: unknown): string[] => {
  const tags = schemaResult(MentionTagsSchema)(raw);
  const hrefs = (tags.isOk() ? (tags.value.tag ?? []) : []).flatMap((entry) =>
    entry.type === "Mention" && entry.href ? [entry.href] : [],
  );
  return [...new Set(hrefs)];
};

/**
 * The usernames of the local accounts among `uris`, each once: an exact
 * actor URL (`/users/name`) or profile URL (`/@name`), as Mastodon's
 * `uris_to_local_accounts` reads both.
 */
const localUsernames = (identity: InstanceIdentity, uris: ReadonlyArray<string>): string[] => {
  const profilePrefix = InstanceIdentity.profileUrl(identity, "");
  return [
    ...new Set(
      uris.flatMap((uri) => {
        const username = uri.startsWith(profilePrefix)
          ? uri.slice(profilePrefix.length)
          : parseLocalActorUsername(identity, uri);
        return username &&
          (InstanceIdentity.actorUrl(identity, username) === uri ||
            InstanceIdentity.profileUrl(identity, username) === uri)
          ? [username.toLowerCase()]
          : [];
      }),
    ),
  ];
};

/**
 * The remote actors a remote note's `Mention` tags name: http(s) URIs off
 * this server, each once. Mastodon keeps them as the status's mentions, which
 * `StatusReachFinder` reaches; they are not fetched here, so only the ones
 * cached by then are reached.
 */
const mentionedRemoteActorUris = (identity: InstanceIdentity, raw: unknown): string[] => {
  const local = new URL(identity.publicOrigin).origin;
  return [
    ...new Set(
      mentionHrefs(raw).flatMap((href) => {
        const url = URL.parse(href);
        return url &&
          (url.protocol === "https:" || url.protocol === "http:") &&
          url.origin !== local
          ? [href]
          : [];
      }),
    ),
  ];
};

/**
 * The local accounts a remote note names, as Mastodon's
 * `ActivityPub::Activity::Create` sorts them. `mentioned` are the ones its
 * `Mention` tags name (`process_mention`): the note's mentions, shown and
 * notified. `addressed` are the ones only its `to`/`cc` name, and the owner
 * of the personal inbox it came to (`process_audience`): silent mentions,
 * which let the account read the note and nothing more.
 */
type LocalAddressees = Readonly<{
  mentioned: ReadonlyArray<string>;
  addressed: ReadonlyArray<string>;
}>;

/**
 * Every local account a remote note names, read in one query. `deliveredTo`
 * is the account whose personal inbox the note came to, if any.
 */
const localAddressees = async (
  db: D1Database,
  identity: InstanceIdentity,
  raw: unknown,
  deliveredTo?: string,
): Promise<Result<LocalAddressees, RepositoryError>> => {
  const note = parseNoteDocument(raw);
  const tagged = localUsernames(identity, mentionHrefs(raw));
  const audience = localUsernames(
    identity,
    note.isOk() ? [...stringList(note.value.to), ...stringList(note.value.cc)] : [],
  );
  const accounts = await findAccountsByUsernames(db, [...tagged, ...audience]);
  if (accounts.isErr()) {
    return err(accounts.error);
  }
  const ids = new Map<string, string>(
    accounts.value.map((account) => [account.username, account.id]),
  );
  const accountIds = (usernames: ReadonlyArray<string>) =>
    usernames.flatMap((username) => ids.get(username) ?? []);
  const mentioned = accountIds(tagged);
  const mentionedSet = new Set(mentioned);
  return ok({
    mentioned,
    addressed: [
      ...new Set([...accountIds(audience), ...(deliveredTo === undefined ? [] : [deliveredTo])]),
    ].filter((id) => !mentionedSet.has(id)),
  });
};

/**
 * `Create#process_audience`: whether the note reaches an account Mastodon
 * knows other than through a `Mention` tag. That is a local account or a
 * cached remote actor in its `to`/`cc` that no tag names, or the owner of the
 * personal inbox it came to when the note does not mention it. A note its
 * audience makes direct is then limited ({@link Visibility.ofAudience}).
 */
const reachesAudienceOnlyAccount = async (
  db: D1Database,
  identity: InstanceIdentity,
  raw: unknown,
  local: LocalAddressees,
): Promise<Result<boolean, RepositoryError>> => {
  if (local.addressed.length > 0) {
    return ok(true);
  }
  const note = parseNoteDocument(raw);
  const tagged = new Set(mentionHrefs(raw));
  const origin = new URL(identity.publicOrigin).origin;
  const remotes = (
    note.isOk() ? [...stringList(note.value.to), ...stringList(note.value.cc)] : []
  ).flatMap((uri) => {
    const url = URL.parse(uri);
    return url && url.origin !== origin && !tagged.has(uri) ? [uri.split("#")[0] ?? uri] : [];
  });
  const known = await findRemoteActorsByUris(db, remotes);
  return known.map((actors) =>
    [...actors.values()].some((actor) => !tagged.has(RemoteActor.profileUrl(actor))),
  );
};

/**
 * The stored mentions of a remote note, as its notifications screen them:
 * the local accounts it mentions now (`mentioned`), and its `MentionedPost`
 * (those, the remote actors its `Mention` tags name, and the author of the
 * stored status it replies to). A failed mention read is an error: without
 * it the mute check on the other involved accounts would be skipped. A
 * failed parent read screens without the parent's author.
 */
const storedMentions = async (
  db: D1Database,
  identity: InstanceIdentity,
  status: RemoteStatusValue,
): Promise<
  Result<Readonly<{ mentioned: ReadonlySet<string>; post: MentionedPost }>, RepositoryError>
> => {
  const [mentions, parent] = await Promise.all([
    listShownRemoteStatusMentions(db, [status.id]),
    findThreadParent(db, identity, { kind: "Remote", status }),
  ]);
  if (mentions.isErr()) {
    return err(mentions.error);
  }
  const stored = mentions.value.get(status.id);
  const accountIds = stored?.accountIds ?? [];
  return ok({
    mentioned: new Set(accountIds),
    post: mentionedPost(
      [...accountIds, ...(stored?.actorUris ?? [])],
      parent.isOk() ? parent.value : undefined,
    ),
  });
};

/**
 * What {@link finishRemoteNote} finishes: the note `actor` wrote, as stored
 * (`status`) and as delivered or fetched (`raw`).
 *
 * `Created` is a note stored from `raw`. `marker` is the one written with its
 * row, or one another delivery wrote whose steps this one finishes; this
 * delivery holds its lease. Absent for a note that owes nothing (one that
 * was fetched and is not distributed, or one whose row existed). `inReplyTo`
 * is the status `raw` replies to, as read when it was parsed.
 *
 * `Updated` is an `Update` applied to a stored note. `added` are the local
 * accounts it newly mentions ({@link newlyMentionedAccountIds}, read before
 * the row was written). `edit` is the marker of a change to its content:
 * written by this delivery, or left by one whose late steps failed, which
 * this delivery finishes although the content it carries is already stored.
 * Absent for an `Update` that edits nothing, or whose pending edit another
 * delivery is finishing.
 *
 * `addressees` are the local accounts `raw` names, when the caller read them
 * already; the steps read them otherwise.
 */
export type LateSteps = Readonly<{
  actor: RemoteActor;
  raw: unknown;
  status: RemoteStatusValue;
  options: PersistOptions;
  addressees?: LocalAddressees;
}> &
  (
    | Readonly<{ kind: "Created"; marker: HeldOwed | undefined; inReplyTo: string | undefined }>
    | Readonly<{
        kind: "Updated";
        added: ReadonlyArray<string>;
        edit: HeldOwed | undefined;
      }>
  );

/**
 * The local accounts the document `raw` mentions that the stored note
 * `statusId` did not: the ones with no mention row yet, as Mastodon notifies
 * only the mentions an `Update` adds. Read before the `Update` writes
 * anything, and kept on the marker of an edit, as the rows it writes make a
 * redelivery read every mention as one the note already had.
 */
export const newlyMentionedAccountIds = async (
  env: Env,
  identity: InstanceIdentity,
  raw: unknown,
  statusId: string,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> => {
  const addressees = await localAddressees(env.DB, identity, raw);
  if (addressees.isErr()) {
    return err(addressees.error);
  }
  const already = await listActiveRemoteStatusMentionAccountIds(env.DB, statusId);
  if (already.isErr()) {
    return err(already.error);
  }
  return ok(addressees.value.mentioned.filter((accountId) => !already.value.has(accountId)));
};

/**
 * The accounts among `mentioned` to notify of their mention. A note that is
 * distributed ({@link distributed}) notifies all of them. An `Update`
 * notifies the ones it newly mentions, and the ones the edit it finishes did.
 */
const mentionsToNotify = (
  late: LateSteps,
  mentioned: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (late.kind === "Created") {
    return distributed(late) ? mentioned : [];
  }
  const added = new Set([...late.added, ...(late.edit?.mentions ?? [])]);
  return mentioned.filter((accountId) => added.has(accountId));
};

/** Whether `options` store a note an inbox activity its author signed brought. */
const inboxDelivery = (options: PersistOptions): boolean =>
  options.delivery === "Create" || options.delivery === "QuoteRequest";

/**
 * Whether a note `options` store owes its late steps until they finish: a
 * `Created` marker is written with its row, and the next delivery or fetch
 * that finds the marker resumes them ({@link resumeCreated}). A note an
 * inbox activity brings owes them always. A fetched note owes them when it is
 * distributed ({@link distributed}): its notifications must not be lost to a
 * step that fails once.
 */
const owesLateSteps = (options: PersistOptions, publishedAt: IsoInstant): boolean =>
  inboxDelivery(options) ||
  ((options.delivery ?? "Fetched") === "Fetched" &&
    RealtimeWindow.contains(publishedAt, nowInstant()));

/** When the note `marker` stands for was stored: the delivery that wrote it decided then. */
const storedAt = (marker: OwedMarker): IsoInstant =>
  IsoInstant.parse(marker.createdAt).unwrapOr(nowInstant());

/**
 * Whether `late` finishes a new note that Mastodon's `Create#distribute`
 * fans out, notifying the local accounts it mentions and its notifying
 * followers. An inbox `Create` is distributed whenever it was published
 * (`override_timestamps`). A status Mastodon fetches is distributed when it
 * was published within the real-time window (`within_realtime_window?`) of
 * the moment it was stored, which its marker records, as Mastodon decides
 * once, when it creates the status: a `QuoteRequest`'s instrument
 * (`FetchRemoteStatusService`) and a note this server fetched and stored
 * first, as a boosted, quoted, replied-to, pinned or searched one. A note an
 * outbox backfill stored is not: Mastodon reads no outbox.
 */
const distributed = (late: LateSteps): boolean => {
  if (late.kind !== "Created") {
    return false;
  }
  const { marker } = late;
  switch (late.options.delivery ?? "Fetched") {
    case "Create":
      return true;
    case "QuoteRequest":
    case "Fetched":
      return (
        marker !== undefined && RealtimeWindow.contains(late.status.publishedAt, storedAt(marker))
      );
    case "Backfilled":
      return false;
  }
};

/**
 * Where the stored note `status` sits in its thread, by whom it answers as
 * stored when it was linked ({@link NoteThread.of}): a reply to a parent
 * that was not held answers no one, and counts as a reply to someone else.
 */
const remoteNoteThread = async (
  db: D1Database,
  status: RemoteStatusValue,
): Promise<Result<NoteThread, RepositoryError>> =>
  (await findRemoteStatusReplyTargets(db, [status.id])).map((targets) =>
    NoteThread.of(targets.get(status.id)?.replyLink ?? { kind: "NotReply" }, {
      kind: "RemoteActor",
      actorUri: status.actorUri,
    }),
  );

/**
 * The followers of a page of the author's notifying followers that a note
 * sends its `status` notification to, and the follow id the next page
 * starts after, if there is one.
 */
type NotifiedPage = Readonly<{ recipients: ReadonlyArray<string>; next: string | undefined }>;

const NOTHING_NOTIFIED: NotifiedPage = { recipients: [], next: undefined };

/**
 * The page after the follow `afterFollowId` (empty for the first) of the
 * local followers the stored note `status` sends its `status` notification
 * to ({@link StatusNotificationAudience}); `addressed` are the local
 * accounts it names. The thread is read only when someone asked, and a
 * reply to someone else, which notifies nobody, reads no further page.
 */
const notifiedPage = async (
  env: Env,
  status: RemoteStatusValue,
  addressed: ReadonlySet<string>,
  afterFollowId: string,
): Promise<Result<NotifiedPage, RepositoryError>> => {
  const page = await notifyingRemoteFollowersPage(
    env.DB,
    status.actorUri,
    status.id,
    signedInRecentlySince(env),
    afterFollowId,
    NOTIFYING_FOLLOWER_PAGE_SIZE,
  );
  if (page.isErr()) {
    return err(page.error);
  }
  if (page.value.followers.length === 0) {
    return ok(NOTHING_NOTIFIED);
  }
  const thread = await remoteNoteThread(env.DB, status);
  if (thread.isErr()) {
    return err(thread.error);
  }
  if (thread.value.kind === "ReplyToOther") {
    return ok(NOTHING_NOTIFIED);
  }
  return ok({
    recipients: StatusNotificationAudience.recipients(
      { visibility: status.visibility, thread: thread.value, language: status.language, addressed },
      page.value.followers,
    ),
    next: page.value.next,
  });
};

/**
 * The first page of the local followers a new note sends its `status`
 * notification to ({@link notifiedPage}). Only a note that is distributed
 * ({@link distributed}) notifies.
 */
const statusNotified = (
  env: Env,
  late: LateSteps,
  addressed: ReadonlySet<string>,
): Promise<Result<NotifiedPage, RepositoryError>> =>
  distributed(late)
    ? notifiedPage(env, late.status, addressed, "")
    : Promise.resolve(ok(NOTHING_NOTIFIED));

/**
 * The local accounts a stored note names, silently or not, which a limited
 * or direct note reaches; none is read for any other note.
 */
const namedAccounts = async (
  db: D1Database,
  status: RemoteStatusValue,
): Promise<Result<ReadonlySet<string>, RepositoryError>> =>
  status.visibility.kind === "Limited" || status.visibility.kind === "Direct"
    ? (await listRemoteStatusMentions(db, [status.id])).map(
        (mentions) => new Set(mentions.get(status.id)?.accountIds ?? []),
      )
    : ok(new Set<string>());

/** The job that reads the page of `status`'s notifying followers after `afterFollowId`. */
const followerPageJob = (status: RemoteStatusValue, afterFollowId: string): OutboxJob => ({
  kind: "NotifyRemoteNoteFollowers",
  statusId: status.id,
  actorUri: status.actorUri,
  afterFollowId,
});

/**
 * `NotifyRemoteNoteFollowers`: a page of a stored note's notifying
 * followers, each the note reaches given a `FinishRemoteNoteRecipient` job
 * with its `Status` step, and the next page. A note that is gone notifies
 * nobody.
 */
export const processNotifyRemoteNoteFollowersJob = async (
  env: Env,
  job: Extract<OutboxJob, { kind: "NotifyRemoteNoteFollowers" }>,
): Promise<"ok" | "retry"> =>
  measureJobPage(env, job.kind, async () => {
    const retry = { outcome: "retry", size: -1, chained: false } as const;
    const identity = parseInstanceIdentity(env);
    if (identity.isErr()) {
      return retry;
    }
    const found = await findRemoteStatusesByIds(env.DB, [job.statusId]);
    if (found.isErr()) {
      return retry;
    }
    const status = found.value.get(job.statusId);
    if (status === undefined) {
      return { outcome: "ok", size: 0, chained: false };
    }
    const named = await namedAccounts(env.DB, status);
    if (named.isErr()) {
      return retry;
    }
    const page = await notifiedPage(env, status, named.value, job.afterFollowId);
    if (page.isErr()) {
      return retry;
    }
    const queued = await queueOutboxJobs(env, [
      ...page.value.recipients.map((accountId): OutboxJob => ({
        kind: "FinishRemoteNoteRecipient",
        statusId: status.id,
        actorUri: status.actorUri,
        accountId,
        steps: ["Status"],
      })),
      ...(page.value.next === undefined ? [] : [followerPageJob(status, page.value.next)]),
    ]);
    return queued.isOk()
      ? {
          outcome: "ok",
          size: page.value.recipients.length,
          chained: page.value.next !== undefined,
        }
      : retry;
  });

/**
 * Distribute the stored note `status` again once its thread is resolved, as
 * Mastodon's `ThreadResolveWorker` runs `DistributionWorker` with
 * `skip_notifications`: no mention notification, but `FeedInsertWorker`
 * still sends the `status` notification, which a reply now known to answer
 * its own author gets. The home and public streams are told again; a client
 * drops a status it already holds. Sending it twice notifies once
 * (`notifyFromRemoteOnce`). A thread job runs it, so its fan-outs are
 * queued, not run in that job's invocation.
 */
export const redistributeRemoteNote = async (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatusValue,
): Promise<Result<void, RepositoryError>> => {
  const named = await namedAccounts(env.DB, status);
  if (named.isErr()) {
    return err(named.error);
  }
  const notified = await notifiedPage(env, status, named.value, "");
  if (notified.isErr()) {
    return err(notified.error);
  }
  const reached = await reachRecipients(env, identity, status.actorUri, status, {
    status: notified.value.recipients,
    nextFollowers: notified.value.next,
    mention: [],
    conversation: [],
  });
  if (reached.isErr()) {
    return err(reached.error);
  }
  await startHomeFanOut(
    env,
    {
      event: "update",
      entryId: status.id,
      author: { kind: "RemoteActor", actorUri: status.actorUri },
    },
    "Queued",
  );
  if (status.visibility.kind === "Public") {
    await startPublicFanOut(env, { event: "update", entryId: status.id }, "Queued");
  }
  return ok(undefined);
};

/**
 * The steps of storing or updating a remote note that run after the batch
 * that writes its row: the mention rows, the mention notifications, the
 * direct conversation of a new note, the quote, the link card, the queued
 * `update` notifications of an edit's boosters and the stream events, then the deletion
 * of the marker that owed them. A failure is returned, so the inbox
 * answers 5xx and the marker stays; the sender's redelivery runs every step
 * again, which is why each one gives the same result the second time: the
 * writes replace what they wrote, a notification is sent once
 * (`notifyFromRemoteOnce`), and the stream events come last, where a client
 * drops a status it already holds.
 *
 * One delivery at a time runs them for a marker: the caller holds its lease
 * (`HeldOwed`). The lease goes with the marker when the steps finish, and is
 * given back when they fail, so the next delivery takes it at once. A
 * delivery that was cut off gives nothing back: its lease expires.
 */
export const finishRemoteNote = async (
  env: Env,
  identity: InstanceIdentity,
  late: LateSteps,
): Promise<Result<void, RepositoryError>> => {
  const held = late.kind === "Created" ? late.marker : late.edit;
  const finished = await runLateSteps(env, identity, late, held);
  if (held !== undefined && finished.isErr()) {
    // Best effort: a lease that is not given back expires.
    await releaseOwed(env.DB, late.status.id, held);
  }
  return finished;
};

const runLateSteps = async (
  env: Env,
  identity: InstanceIdentity,
  late: LateSteps,
  held: HeldOwed | undefined,
): Promise<Result<void, RepositoryError>> => {
  const { actor, status } = late;
  const written = await writeLateSteps(env, identity, late);
  if (written.isErr()) {
    return err(written.error);
  }
  if (held !== undefined && late.options.forward !== undefined) {
    await forwardRemoteActivity(env, identity, status, actor, late.options.forward);
  }
  // The stream events come last. A redelivery that got this far before it
  // failed sends them again, and a client drops a status it already holds.
  // They are started here and run once the response is ready, or queued
  // (`fanOut`), best effort: a page that fails goes to the queue, and
  // nothing they do can fail the delivery. So the marker stands for their
  // start, not their end, and is deleted below without waiting for them.
  const event = streamEvent(late);
  const start = late.options.fanOut ?? "Inline";
  if (event !== undefined) {
    await startHomeFanOut(
      env,
      { event, entryId: status.id, author: { kind: "RemoteActor", actorUri: actor.actorUri } },
      start,
    );
    if (status.visibility.kind === "Public") {
      await startPublicFanOut(env, { event, entryId: status.id }, start);
    }
  }
  return clearOwed(env.DB, status.id, held ? [held] : []);
};

type RecipientStep = "Mention" | "Conversation" | "Status";

/**
 * Notify `recipients.mention` of their mention of the stored note `status`,
 * tell `recipients.conversation` their conversation changed, and send
 * `recipients.status` the note's `status` notification. The first
 * {@link INLINE_NOTE_RECIPIENTS} accounts are served here; each of the rest
 * gets a `FinishRemoteNoteRecipient` job, which does the same for it, and
 * `recipients.nextFollowers` starts the next page of notifying followers. A
 * notification is stored once (`notifyFromRemoteOnce`), so a redelivery that
 * queues an account again notifies it once.
 */
const reachRecipients = async (
  env: Env,
  identity: InstanceIdentity,
  actorUri: string,
  status: RemoteStatusValue,
  recipients: Readonly<{
    mention: ReadonlyArray<string>;
    conversation: ReadonlyArray<string>;
    status: ReadonlyArray<string>;
    nextFollowers: string | undefined;
  }>,
): Promise<Result<void, RepositoryError>> => {
  const steps = new Map<string, RecipientStep[]>();
  const add = (step: RecipientStep) => (accountId: string) => {
    steps.set(accountId, [...(steps.get(accountId) ?? []), step]);
  };
  recipients.mention.forEach(add("Mention"));
  recipients.conversation.forEach(add("Conversation"));
  recipients.status.forEach(add("Status"));
  const ordered = [...steps];
  const inline = ordered.slice(0, INLINE_NOTE_RECIPIENTS);
  const queued = ordered.slice(INLINE_NOTE_RECIPIENTS);
  const served = await serveRecipients(env, identity, actorUri, status, inline);
  if (served.isErr()) {
    return err(served.error);
  }
  // Unqueued: the delivery fails and its redelivery queues them again.
  return queueOutboxJobs(env, [
    ...queued.map(([accountId, accountSteps]): OutboxJob => ({
      kind: "FinishRemoteNoteRecipient",
      statusId: status.id,
      actorUri,
      accountId,
      steps: accountSteps,
    })),
    ...(recipients.nextFollowers === undefined
      ? []
      : [followerPageJob(status, recipients.nextFollowers)]),
  ]);
};

/** What {@link reachRecipients} does for each account it serves itself, and the job for each one it queues. */
const serveRecipients = async (
  env: Env,
  identity: InstanceIdentity,
  actorUri: string,
  status: RemoteStatusValue,
  recipients: ReadonlyArray<readonly [string, ReadonlyArray<RecipientStep>]>,
): Promise<Result<void, RepositoryError>> => {
  const taking = (step: RecipientStep) =>
    recipients.flatMap(([accountId, steps]) => (steps.includes(step) ? [accountId] : []));
  const mention = taking("Mention");
  if (mention.length > 0) {
    const stored = await storedMentions(env.DB, identity, status);
    if (stored.isErr()) {
      return err(stored.error);
    }
    // A queued account an `Update` has since made silent is mentioned no more.
    for (const accountId of mention.filter((id) => stored.value.mentioned.has(id))) {
      const sent = await notifyFromRemoteOnce(
        env,
        { accountId, actorUri, kind: "mention", statusId: status.id },
        undefined,
        stored.value.post,
      );
      if (sent.isErr()) {
        return err(sent.error);
      }
    }
  }
  const conversation = taking("Conversation");
  if (conversation.length > 0) {
    await publishConversationUpdate(env, identity, conversation, status.id);
  }
  for (const accountId of taking("Status")) {
    const sent = await notifyFromRemoteOnce(env, {
      accountId,
      actorUri,
      kind: "status",
      statusId: status.id,
    });
    if (sent.isErr()) {
      return err(sent.error);
    }
  }
  return ok(undefined);
};

/**
 * `FinishRemoteNoteRecipient`: what the inbox request that stored the note
 * left to the queue for one account. A note that is gone has nothing left to
 * finish.
 */
export const processFinishRemoteNoteRecipientJob = async (
  env: Env,
  job: Extract<OutboxJob, { kind: "FinishRemoteNoteRecipient" }>,
): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return "retry";
  }
  const found = await findRemoteStatusesByIds(env.DB, [job.statusId]);
  if (found.isErr()) {
    return "retry";
  }
  const status = found.value.get(job.statusId);
  if (status === undefined) {
    return "ok";
  }
  // As `FeedInsertWorker#notify?` reads the follow when it runs, a follower
  // that unfollowed, turned notifications off, muted the actor, or blocked
  // or muted an account the note mentions since the job was queued gets no
  // `status` notification.
  const notifying = job.steps.includes("Status")
    ? await isNotifyingRemoteFollower(env.DB, job.accountId, job.actorUri, job.statusId)
    : ok(true);
  if (notifying.isErr()) {
    return "retry";
  }
  const steps = notifying.value ? job.steps : job.steps.filter((step) => step !== "Status");
  const served = await serveRecipients(env, identity.value, job.actorUri, status, [
    [job.accountId, steps],
  ]);
  return served.isOk() ? "ok" : "retry";
};

/** The steps of {@link finishRemoteNote} before the stream events: every write and notification. */
const writeLateSteps = async (
  env: Env,
  identity: InstanceIdentity,
  late: LateSteps,
): Promise<Result<void, RepositoryError>> => {
  const { actor, raw, status, options } = late;
  const addressees =
    late.addressees === undefined
      ? await localAddressees(env.DB, identity, raw, options.deliveredTo)
      : ok(late.addressees);
  if (addressees.isErr()) {
    return err(addressees.error);
  }
  const { mentioned, addressed } = addressees.value;
  const recorded = await recordRemoteStatusMentions(env.DB, status.id, {
    mentioned,
    addressed,
    remotes: mentionedRemoteActorUris(identity, raw),
  });
  if (recorded.isErr()) {
    return err(recorded.error);
  }
  // `Create#resolve_thread`: a new note that replies to a status not stored
  // queues the job that fetches it, whether an inbox activity brought it or
  // this server fetched it, as Mastodon runs every status it stores through
  // `Create`. An outbox backfill queues none: Mastodon reads no outbox.
  const thread = options.thread ?? { kind: "Queue", hop: 1 };
  if (
    late.kind === "Created" &&
    options.delivery !== "Backfilled" &&
    thread.kind === "Queue" &&
    late.inReplyTo !== undefined &&
    fetchableParent(identity, late.inReplyTo)
  ) {
    const resolving = await queueRemoteThreadResolve(env, identity, status.id, thread.hop);
    if (resolving.isErr()) {
      return err(resolving.error);
    }
  }
  const notified = await statusNotified(env, late, new Set([...mentioned, ...addressed]));
  if (notified.isErr()) {
    return err(notified.error);
  }
  // Mention rows exist before the notifications that point at them. They are
  // sent before the later writes: an `Update` that edits nothing owes no
  // marker, so its redelivery finds the rows and would notify nobody.
  const reached = await reachRecipients(env, identity, actor.actorUri, status, {
    status: notified.value.recipients,
    nextFollowers: notified.value.next,
    mention: mentionsToNotify(late, mentioned),
    // Everyone a new direct note reaches here: the conversation lists it for
    // each. A limited note joins no conversation (`FanOutOnWriteService`).
    conversation:
      late.kind === "Created" && status.visibility.kind === "Direct"
        ? [...mentioned, ...addressed]
        : [],
  });
  if (reached.isErr()) {
    return err(reached.error);
  }
  const quote = await syncRemoteQuote(
    env,
    identity,
    status,
    raw,
    remoteQuoteContext(env, identity, actor, options),
  );
  if (quote.isErr()) {
    return err(quote.error);
  }
  // Preview cards are built off the request path like for local posts.
  startLinkCard(env, "RemoteStatus", status.id, status.contentHtml, noteCardUrl(raw));
  if (late.kind === "Updated" && late.edit) {
    const boosters = await notifyRemoteNoteBoosters(env, {
      statusId: status.id,
      actorUri: actor.actorUri,
      since: late.edit.createdAt,
    });
    if (boosters.isErr()) {
      return err(boosters.error);
    }
  }
  return ok(undefined);
};

/**
 * The stream event the finished note is sent with, if any. An edit is
 * `status.update`. A new note is `update` when it is distributed
 * ({@link distributed}): Mastodon's `DistributionWorker` streams it to the
 * home, list, public and hashtag streams, for an inbox `Create`, a
 * `QuoteRequest`'s instrument and a note this server fetched first alike,
 * as `FetchRemoteStatusService` runs the last two as a `Create`. Only a note
 * whose marker this delivery holds streams, and only one published
 * recently, as Mastodon's `Status::REAL_TIME_WINDOW`: an old note arriving
 * late would show up in clients as a new status. A marker read back on a
 * redelivery counts as stored now: the delivery that wrote it never got
 * this far, so the note was not streamed.
 */
const streamEvent = (late: LateSteps): "update" | "status.update" | undefined => {
  if (late.kind === "Updated") {
    return late.edit ? "status.update" : undefined;
  }
  return late.marker !== undefined &&
    distributed(late) &&
    RealtimeWindow.contains(late.status.publishedAt, nowInstant())
    ? "update"
    : undefined;
};

type PersistOptions = FederatedFetchOptions &
  Readonly<{
    /**
     * How the note arrives; `Fetched` by default. `Create` and `QuoteRequest`
     * are inbox activities its author signed, which the sender delivers again
     * after a 5xx: a new note's late steps stay owed (`remote_status_owed`)
     * until they finish, so the redelivery resumes them. `Backfilled` is a
     * note an outbox backfill fetched. Which new notes notify is
     * {@link distributed}.
     */
    delivery?: "Create" | "QuoteRequest" | "Fetched" | "Backfilled";
    /** Which instant a newly stored note's id sorts at; `Received` by default. */
    idClock?: IdClock;
    /**
     * Whether a newly stored reply whose parent is not stored queues its
     * thread job ({@link queueRemoteThreadResolve}), and at which hop of its
     * chain; hop 1 by default. A note a thread job fetches sits one hop
     * further up that job's chain. A note fetched under another one, as a
     * quoted note or a reply a thread fetch finds listed, or a parent the
     * thread fetch walks to itself, starts no chain: each chain stays one line
     * of parents, which its hop bounds, where Mastodon bounds every fetch a
     * request sets off with one counter (`DISCOVERIES_PER_REQUEST`).
     */
    thread?: ThreadResolve;
    /**
     * How the stream fan-outs of a note this stores start: `Inline` by
     * default, their first page run once the response is ready; `Queued`
     * for a background job that stores many notes, whose invocation could
     * not afford a first page for each.
     */
    fanOut?: JobStart;
    /**
     * How many quotes deep this note sits below the note that arrived (0 by
     * default); a note fetched as a quoted one is one deeper than its quoting
     * note. See {@link MAX_QUOTE_DEPTH}.
     */
    quoteDepth?: number;
    /**
     * The inbox activity the note arrived in, as received. When storing it
     * or applying its edit owes late steps, they forward it
     * ({@link forwardRemoteActivity}), as Mastodon forwards a new reply and
     * a newer edit, but not a note it already had.
     */
    forward?: ReceivedActivity;
    /**
     * The local account whose personal inbox the `Create` came to, as
     * Mastodon's `delivered_to_account_id`: the note becomes readable to it
     * (a silent mention when it is not mentioned), and a direct note that
     * does not mention it is limited.
     */
    deliveredTo?: string;
  }>;

type ObjectReference = string | Readonly<{ id: string } & Record<string, unknown>>;

/**
 * What stands at a URI in place of a cached remote status: `Local` is one of
 * this instance's own statuses, `Unreadable` a stored row that does not read
 * as a status. Nothing is stored over a local status. An unreadable row is
 * replaced only by its author's document ({@link healFromFetch}, or the
 * author's own `Create` or `Update`).
 */
type Uncacheable =
  | Readonly<{ kind: "Local" }>
  | Readonly<{ kind: "Unreadable"; row: InvalidRemoteStatusRow }>;

/**
 * The cached remote status for `objectUri`, or why there can be none;
 * `known` is the caller's read of it, when it made one. A row that does not
 * read is settled here, as reading it again gives the same row: a caller
 * that fetches notes heals it from its author's document, and any other
 * drops what refers to it, where a failed read is an error.
 */
const cachedRemoteStatus = async (
  env: Env,
  identity: InstanceIdentity,
  objectUri: string,
  known: KnownRemoteStatus | undefined,
): Promise<Result<Uncacheable | RemoteStatusValue | undefined, RepositoryError>> => {
  if (parseLocalStatusId(identity, objectUri)) {
    return ok({ kind: "Local" });
  }
  if (known?.objectUri === objectUri) {
    return ok(known.row);
  }
  const read = await findDeliveredRemoteStatus(env.DB, objectUri);
  if (read.isErr() && read.error.kind === "StoredRowInvalid") {
    const row = read.error;
    return readableRow(read).map(() => ({ kind: "Unreadable", row }));
  }
  return readableRow(read);
};

/**
 * Replace the row at `objectUri`, which does not read as a status, from the
 * document its URI serves, and give the status it then reads as. The proof
 * is the one a fetched note needs to be stored ({@link fetchedAsItself}): the
 * document names `objectUri` as its id and sits on its author's host, and
 * that author is the one the row names. `undefined` when the fetch fails,
 * the proof does not hold, or the heal keeps the row
 * ({@link settleInvalidRemoteStatus}): the caller goes on without the note.
 * `asker` is the actor whose activity refers to the note, which spares
 * resolving the author when it is the same.
 */
const healFromFetch = async (
  env: Env,
  identity: InstanceIdentity,
  asker: RemoteActor,
  objectUri: string,
  row: InvalidRemoteStatusRow,
  options: PersistOptions,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const raw = await fetchActivityJson(identity, objectUri, options);
  if (raw.isErr() || !fetchedAsItself(raw.value, objectUri)) {
    return ok(undefined);
  }
  const note = parseNoteDocument(raw.value);
  if (note.isErr() || note.value.attributedTo !== row.actorUri) {
    return ok(undefined);
  }
  const author =
    asker.actorUri === row.actorUri
      ? ok(asker)
      : await resolveRemoteActor(env.DB, identity, row.actorUri, options);
  if (author.isErr()) {
    return author.error.kind === "RepositoryError" ? err(author.error) : ok(undefined);
  }
  return settleInvalidRemoteStatus(env, author.value, row, { activity: "Fetched", raw: raw.value });
};

export const persistRemoteObject = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  object: ObjectReference,
  options: PersistOptions,
  known?: KnownRemoteStatus,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const objectUri = typeof object === "string" ? object : object.id;
  const cached = await cachedRemoteStatus(env, identity, objectUri, known);
  if (cached.isErr()) {
    return err(cached.error);
  }
  if (cached.value) {
    if (cached.value.kind !== "RemoteNote") {
      return ok(undefined);
    }
    const status = cached.value;
    const resumed = await resumeCreated(env, identity, actor, object, status, options);
    return resumed.map(() => status);
  }
  if (typeof object !== "string") {
    return storeRemoteNote(env, identity, actor, object, options, { objectUri, row: undefined });
  }
  const raw = await fetchActivityJson(identity, object, options);
  if (raw.isErr() || !fetchedAsItself(raw.value, object)) {
    return ok(undefined);
  }
  return storeRemoteNote(env, identity, actor, raw.value, options);
};

/**
 * Whether a note fetched from `uri` names `uri` as its id and sits on its
 * author's host, as Mastodon's `FetchRemoteStatusService` requires (and
 * {@link persistAnnouncedObject} of another actor's note): a document served
 * under one URI cannot claim another.
 */
const fetchedAsItself = (raw: unknown, uri: string): boolean => {
  const note = parseNoteDocument(raw);
  if (note.isErr() || note.value.id !== uri) {
    return false;
  }
  const host = urlHost(uri);
  return host !== undefined && host === urlHost(note.value.attributedTo);
};

/**
 * The status an `Announce` shares, cached. The booster's own note may come
 * embedded. Another actor's note is fetched from its URI, must name that URI
 * as its id and come from its author's host, and is stored under its author,
 * whose actor is resolved first, as Mastodon does.
 */
export const persistAnnouncedObject = async (
  env: Env,
  identity: InstanceIdentity,
  announcer: RemoteActor,
  object: ObjectReference,
  options: PersistOptions,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const objectUri = typeof object === "string" ? object : object.id;
  const cached = await cachedRemoteStatus(env, identity, objectUri, undefined);
  if (cached.isErr()) {
    return err(cached.error);
  }
  if (cached.value?.kind === "Unreadable") {
    return healFromFetch(env, identity, announcer, objectUri, cached.value.row, options);
  }
  if (cached.value) {
    if (cached.value.kind !== "RemoteNote") {
      return ok(undefined);
    }
    const status = cached.value;
    return (await resumeFetched(env, identity, announcer, status, options)).map(() => status);
  }
  if (typeof object !== "string") {
    const embedded = parseNoteDocument(object);
    if (embedded.isOk() && embedded.value.attributedTo === announcer.actorUri) {
      return storeRemoteNote(env, identity, announcer, object, options, {
        objectUri,
        row: undefined,
      });
    }
  }
  return storeFetchedNote(env, identity, objectUri, options, announcer);
};

/**
 * Store the document `objectUri` served as the note it is, under its author.
 * The document must name that URI as its id. `asker`, when it is the author,
 * vouches for its own note; any other author must sit on the URI's host and
 * is resolved first, as Mastodon's `FetchRemoteStatusService`. A `Create`
 * served there stores its object (`expected_activity_type?`): the `Create`
 * must sit on its actor's host (`trustworthy_attribution?`), and so must its
 * object, which is fetched when only named, unless it is stored already. `undefined` when the document is
 * no note or the proof does not hold.
 */
export const storeNoteDocument = async (
  env: Env,
  identity: InstanceIdentity,
  objectUri: string,
  raw: unknown,
  options: PersistOptions,
  asker?: RemoteActor,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const created = parseCreateDocument(raw);
  if (created.isErr()) {
    return storeNote(env, identity, objectUri, raw, options, asker);
  }
  const actorHost = urlHost(created.value.actor);
  const noteUri = refId(created.value.object);
  if (
    created.value.id !== objectUri ||
    actorHost === undefined ||
    actorHost !== urlHost(objectUri) ||
    noteUri === undefined ||
    actorHost !== urlHost(noteUri)
  ) {
    return ok(undefined);
  }
  // As `Create#find_existing_status`, a status already stored is the one
  // shared: an old `Create` does not roll back a later edit.
  const cached = await cachedRemoteStatus(env, identity, noteUri, undefined);
  if (cached.isErr()) {
    return err(cached.error);
  }
  if (cached.value) {
    return ok(cached.value.kind === "RemoteNote" ? cached.value : undefined);
  }
  if (typeof created.value.object !== "string") {
    return storeNote(env, identity, noteUri, created.value.object, options, asker);
  }
  const fetched = await fetchActivityJson(identity, noteUri, options);
  return fetched.isErr()
    ? ok(undefined)
    : storeNote(env, identity, noteUri, fetched.value, options, asker);
};

/** {@link storeNoteDocument} of a note: no `Create` is read here, so one never leads to another. */
const storeNote = async (
  env: Env,
  identity: InstanceIdentity,
  objectUri: string,
  raw: unknown,
  options: PersistOptions,
  asker?: RemoteActor,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const note = parseNoteDocument(raw);
  if (note.isErr() || note.value.id !== objectUri) {
    return ok(undefined);
  }
  const authorUri = note.value.attributedTo;
  if (asker !== undefined && authorUri === asker.actorUri) {
    return storeRemoteNote(env, identity, asker, raw, options);
  }
  const authorHost = urlHost(authorUri);
  if (authorHost === undefined || authorHost !== urlHost(objectUri)) {
    return ok(undefined);
  }
  const author = await resolveRemoteActor(env.DB, identity, authorUri, options);
  if (author.isErr()) {
    return author.error.kind === "RepositoryError" ? err(author.error) : ok(undefined);
  }
  return storeRemoteNote(env, identity, author.value, raw, options);
};

/** Fetch the note at `objectUri` and store it ({@link storeNoteDocument}). `undefined` when the fetch fails. */
export const storeFetchedNote = async (
  env: Env,
  identity: InstanceIdentity,
  objectUri: string,
  options: PersistOptions,
  asker?: RemoteActor,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const raw = await fetchActivityJson(identity, objectUri, options);
  return raw.isErr()
    ? ok(undefined)
    : storeNoteDocument(env, identity, objectUri, raw.value, options, asker);
};

/**
 * What is stored for `objectUri`, for a lookup by URL (search with
 * `resolve=true`), which reads it before it fetches anything: that also finds
 * a followers-only or direct note this server was sent, which its URI does
 * not serve to the instance actor. `note` is `undefined` for a local status's
 * URI and for a row that is no readable note: such a URL names no remote
 * status and is not fetched. The whole answer is `undefined` when nothing is
 * stored.
 */
export const findStoredNote = async (
  env: Env,
  identity: InstanceIdentity,
  objectUri: string,
): Promise<
  Result<Readonly<{ note: RemoteStatusValue | undefined }> | undefined, RepositoryError>
> =>
  (await cachedRemoteStatus(env, identity, objectUri, undefined)).map(
    (cached) => cached && { note: cached.kind === "RemoteNote" ? cached : undefined },
  );

/**
 * How deep quoted notes are fetched below the note that arrived, as
 * Mastodon's `VerifyQuoteService::MAX_SYNCHRONOUS_DEPTH` (2): notes at depth
 * 0, 1 and 2 fetch their quoted notes, so up to three levels are stored. A
 * note deeper than that keeps its quote of an uncached note unresolved.
 */
export const MAX_QUOTE_DEPTH = 3;

/**
 * Store an inlined copy of a quoted note when the actor that sent it vouches
 * for it, as Mastodon's `safe_prefetched_embed`: its id is `uri`, it is
 * `vouchedBy`'s own note, and it sits on `vouchedBy`'s host. Otherwise, or
 * when that actor cannot be resolved, `undefined`, and the caller fetches by
 * id instead.
 */
const persistVouchedQuoted = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  uri: string,
  embedded: EmbeddedQuoted,
  options: PersistOptions,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const note = parseNoteDocument(embedded.object);
  const host = urlHost(uri);
  if (
    note.isErr() ||
    note.value.id !== uri ||
    note.value.attributedTo !== embedded.vouchedBy ||
    host === undefined ||
    host !== urlHost(embedded.vouchedBy)
  ) {
    return ok(undefined);
  }
  if (embedded.vouchedBy === actor.actorUri) {
    return storeRemoteNote(env, identity, actor, embedded.object, options);
  }
  const author = await resolveRemoteActor(env.DB, identity, embedded.vouchedBy, options);
  if (author.isErr()) {
    return author.error.kind === "RepositoryError" ? err(author.error) : ok(undefined);
  }
  return storeRemoteNote(env, identity, author.value, embedded.object, options);
};

/**
 * How a note `actor` wrote reaches the note it quotes and that quote's stamp.
 * An uncached quoted note comes from an inlined copy its sender vouches for
 * ({@link persistVouchedQuoted}), else is fetched as an announced one, while
 * `options.quoteDepth` is under {@link MAX_QUOTE_DEPTH}; the quoted note is
 * stored one level deeper.
 */
export const remoteQuoteContext = (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  options: PersistOptions,
): RemoteQuoteContext => {
  const depth = options.quoteDepth ?? 0;
  const mayFetch = depth < MAX_QUOTE_DEPTH;
  const { forward: _forward, deliveredTo: _deliveredTo, ...fetchOnly } = options;
  const nested: PersistOptions = {
    ...fetchOnly,
    delivery: options.delivery === "Backfilled" ? "Backfilled" : "Fetched",
    quoteDepth: depth + 1,
    thread: { kind: "Skip" },
  };
  return {
    fetchOptions: options,
    mayFetch,
    resolveQuoted: async (uri, embedded) => {
      const cached = await cachedRemoteStatus(env, identity, uri, undefined);
      if (cached.isErr()) {
        return err(cached.error);
      }
      // A quoted note whose row does not read is healed where a note is
      // fetched, and else left: the quote stays unresolved, as one whose
      // note cannot be fetched.
      if (cached.value?.kind === "Unreadable" && mayFetch) {
        return healFromFetch(env, identity, actor, uri, cached.value.row, nested);
      }
      if (cached.value || !mayFetch) {
        return ok(cached.value?.kind === "RemoteNote" ? cached.value : undefined);
      }
      if (embedded) {
        const vouched = await persistVouchedQuoted(env, identity, actor, uri, embedded, nested);
        if (vouched.isErr() || vouched.value) {
          return vouched;
        }
      }
      return persistAnnouncedObject(env, identity, actor, uri, nested);
    },
  };
};

const parseCreateDocument = schemaResult(CreateDocumentSchema);

const urlHost = (href: string): string | undefined => {
  try {
    return new URL(href).host.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * Store a note document `actor` wrote, with its mentions and a queued preview
 * card. `known` is the caller's read of the note's URI, made with no fetch
 * since, so the upsert need not read it again.
 */
const storeRemoteNote = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  raw: unknown,
  options: PersistOptions,
  known?: KnownRemoteStatus,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const parsed = noteFromUnknown(raw, actor, options.idClock);
  if (parsed.isErr()) {
    return ok(undefined);
  }
  const media = await applyMediaPolicy(env, actor, parsed.value);
  const note = parseNoteDocument(raw);
  const inReplyTo = note.isOk() ? (note.value.inReplyTo ?? undefined) : undefined;
  // A note that replies to itself would make its own thread a cycle.
  if (inReplyTo === media.objectUri) {
    return ok(undefined);
  }
  const read = await cachedRemoteStatus(env, identity, media.objectUri, known);
  if (read.isErr()) {
    return err(read.error);
  }
  if (read.value && read.value.kind !== "RemoteNote") {
    return ok(undefined);
  }
  if (read.value && !inboxDelivery(options)) {
    const resumed = await resumeCreated(env, identity, actor, raw, read.value, options);
    if (resumed.isErr()) {
      return err(resumed.error);
    }
  }
  // Mastodon sets a note's visibility once, when it stores it
  // (`Create#process_status`): a note stored again keeps the one it has.
  const addressees = await localAddressees(env.DB, identity, raw, options.deliveredTo);
  if (addressees.isErr()) {
    return err(addressees.error);
  }
  const audienceOnly =
    read.value === undefined && media.visibility.kind === "Direct"
      ? await reachesAudienceOnlyAccount(env.DB, identity, raw, addressees.value)
      : ok(false);
  if (audienceOnly.isErr()) {
    return err(audienceOnly.error);
  }
  const status: RemoteStatusValue = {
    ...media,
    visibility:
      read.value?.visibility ??
      Visibility.ofAudience(media.visibility, { audienceOnly: audienceOnly.value }),
  };
  const existing: KnownRemoteStatus = { objectUri: status.objectUri, row: read.value };
  // A note an inbox activity stores owes its late steps until they finish.
  const marker =
    existing.row === undefined && owesLateSteps(options, status.publishedAt)
      ? newOwedMarker("Created")
      : undefined;
  const stored = await upsertRemoteStatus(
    env.DB,
    status,
    noteHashtags(raw),
    noteReplyTo(identity, inReplyTo),
    existing,
    [],
    marker ? [(id) => owedStatement(env.DB, id, marker)] : [],
  );
  if (stored.isErr()) {
    return err(stored.error);
  }
  if (stored.value === undefined) {
    return existing.row === undefined
      ? storedMeanwhile(env, identity, actor, raw, status.objectUri, options)
      : ok(undefined);
  }
  await recordNoteEmojis(env.DB, actor, raw, stored.value);
  const finished = await finishRemoteNote(env, identity, {
    kind: "Created",
    actor,
    raw,
    status: stored.value,
    options,
    marker,
    inReplyTo,
    addressees: addressees.value,
  });
  return finished.map(() => stored.value);
};

/**
 * The note `actor` wrote that another delivery stored at `objectUri` while
 * this one, which read the URI as free, was about to. This delivery wrote
 * nothing, so it is one that found the note cached: it leaves the row and
 * writes no marker, and finishes what the other delivery owes as a
 * redelivery would ({@link resumeCreated}).
 */
const storedMeanwhile = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  raw: unknown,
  objectUri: string,
  options: PersistOptions,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const cached = await cachedRemoteStatus(env, identity, objectUri, undefined);
  if (cached.isErr()) {
    return err(cached.error);
  }
  const status = cached.value;
  if (status?.kind !== "RemoteNote" || status.actorUri !== actor.actorUri) {
    return ok(undefined);
  }
  const resumed = await resumeCreated(env, identity, actor, raw, status, options);
  return resumed.map(() => status);
};

/**
 * Whether the note `delivered` is the version `stored` holds: both unedited,
 * or both edited at the same instant. A `Create` of the original, or of a
 * version an `Update` has since replaced, is not.
 */
const sameVersion = (delivered: RemoteStatusValue, stored: RemoteStatusValue): boolean =>
  delivered.editedAt.kind === "Edited"
    ? stored.editedAt.kind === "Edited" && stored.editedAt.at === delivered.editedAt.at
    : stored.editedAt.kind !== "Edited";

/**
 * Finish what the fetch that stored `status` left owed, as
 * {@link resumeCreated} does, when another activity, `asker`'s, shares the
 * note: the note's author, cached, vouches for the document its URI serves.
 * The marker is read first, so a note that owes nothing costs one read.
 */
const resumeFetched = async (
  env: Env,
  identity: InstanceIdentity,
  asker: RemoteActor,
  status: RemoteStatusValue,
  options: PersistOptions,
): Promise<Result<void, RepositoryError>> => {
  if (options.delivery === "Backfilled") {
    return ok(undefined);
  }
  if (asker.actorUri === status.actorUri) {
    return resumeCreated(env, identity, asker, status.objectUri, status, options);
  }
  const owed = await listOwed(env.DB, status.id);
  if (owed.isErr()) {
    return err(owed.error);
  }
  if (!owed.value.some((marker) => marker.kind === "Created")) {
    return ok(undefined);
  }
  const author = await findRemoteActorByUri(env.DB, status.actorUri);
  if (author.isErr()) {
    return err(author.error);
  }
  return author.value === undefined
    ? ok(undefined)
    : resumeCreated(env, identity, author.value, status.objectUri, status, options);
};

/**
 * Finish what the delivery that stored `status` left owed, when `actor`
 * wrote the note and delivers it again in an inbox activity. The stored row
 * is kept as it is; only the late steps run, from the document delivered
 * now, and only when it is the version stored ({@link sameVersion}). A note
 * edited since is left alone: the `Update` wrote its mentions and quote from
 * a newer document than the one delivered, so the marker stays until the
 * sweep deletes it.
 *
 * Only the delivery that gets the marker's lease runs the steps
 * ({@link claimOwed}). One that does not has nothing of its own left to do
 * and goes on, answered 202: every step, the stream event included, is the
 * holder's, whose sender delivers again when it fails.
 *
 * A `QuoteRequest` is the exception for one step: it answers the quote the
 * note makes, which the holder may not have stored yet, and a request
 * answered 202 without one is never sent again. So it syncs the quote
 * itself, outside the lease. That is safe beside the holder's own sync: both
 * read the same document, a quote of the same status is kept as it is with
 * the state it has (`syncRemoteQuote`), and of two that insert it at once
 * one fails on the unique quoting status, is answered 5xx and finds the row
 * when it is delivered again.
 */
const resumeCreated = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  /** The note's document, or its URI, which is fetched. */
  object: unknown,
  status: RemoteStatusValue,
  options: PersistOptions,
): Promise<Result<void, RepositoryError>> => {
  if (options.delivery === "Backfilled" || status.actorUri !== actor.actorUri) {
    return ok(undefined);
  }
  const owed = await listOwed(env.DB, status.id);
  if (owed.isErr()) {
    return err(owed.error);
  }
  const marker = owed.value.find((entry) => entry.kind === "Created");
  if (marker === undefined) {
    return ok(undefined);
  }
  let raw: unknown = object;
  if (typeof object === "string") {
    const fetched = await fetchActivityJson(identity, object, options);
    if (fetched.isErr() || !fetchedAsItself(fetched.value, object)) {
      return ok(undefined);
    }
    raw = fetched.value;
  }
  const delivered = noteFromUnknown(raw, actor);
  if (delivered.isErr() || !sameVersion(delivered.value, status)) {
    return ok(undefined);
  }
  const held = await claimOwed(env.DB, status.id, marker);
  if (held.isErr()) {
    return err(held.error);
  }
  if (held.value === undefined) {
    return options.delivery === "QuoteRequest"
      ? syncRemoteQuote(
          env,
          identity,
          status,
          raw,
          remoteQuoteContext(env, identity, actor, options),
        )
      : ok(undefined);
  }
  const note = parseNoteDocument(raw);
  return finishRemoteNote(env, identity, {
    kind: "Created",
    actor,
    raw,
    status,
    options,
    marker: held.value,
    inReplyTo: note.isOk() ? (note.value.inReplyTo ?? undefined) : undefined,
  });
};
