import {
  InstanceIdentity,
  RealtimeWindow,
  StatusTarget,
  type RemoteActor,
  type RemoteStatus as RemoteStatusValue,
  type MentionedPost,
  type OutboxJob,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { nowInstant } from "./clock";
import { readableRow, type RepositoryError, toRepositoryError } from "./d1";
import { parseInstanceIdentity } from "./runtime-config";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { resolveRemoteActor } from "./remote-actor-fetch";
import type { IdClock } from "./ids";
import { parseLocalActorUsername, parseLocalStatusId } from "./activitypub";
import { findAccountsByUsernames } from "./account-store";
import { startLinkCard } from "./link-card";
import { mentionedPost, notifyFromRemoteOnce } from "./notify";
import { startHomeFanOut } from "./home-fan-out";
import { startPublicFanOut } from "./public-fan-out";
import {
  applyMediaPolicy,
  noteFromUnknown,
  noteHashtags,
  parseNoteDocument,
} from "./remote-note-document";
import {
  claimOwed,
  clearOwed,
  type HeldOwed,
  listOwed,
  newOwedMarker,
  owedStatement,
  releaseOwed,
} from "./remote-status-owed";
import { findThreadParent } from "./thread-context";
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
  listShownRemoteStatusMentions,
  recordRemoteStatusMentions,
} from "./mention-store";
import { listLocalBoosterAccountIds } from "./status-interaction-store";
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

/** The `href` of each `Mention` tag of a note document, each once. */
const mentionHrefs = (raw: unknown): string[] => {
  const tags = schemaResult(MentionTagsSchema)(raw);
  const hrefs = (tags.isOk() ? (tags.value.tag ?? []) : []).flatMap((entry) =>
    entry.type === "Mention" && entry.href ? [entry.href] : [],
  );
  return [...new Set(hrefs)];
};

/** The usernames of the exact local actor URLs among `uris`, each once. */
const localUsernames = (identity: InstanceIdentity, uris: ReadonlyArray<string>): string[] => [
  ...new Set(
    uris.flatMap((uri) => {
      const username = parseLocalActorUsername(identity, uri);
      return username && InstanceIdentity.actorUrl(identity, username) === uri
        ? [username.toLowerCase()]
        : [];
    }),
  ),
];

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
 * notified. `addressed` are the ones only its `to`/`cc` name
 * (`process_audience`): silent mentions, which let the account read the note
 * and nothing more.
 */
type LocalAddressees = Readonly<{
  mentioned: ReadonlyArray<string>;
  addressed: ReadonlyArray<string>;
}>;

/** Every local account a remote note names, read in one query. */
const localAddressees = async (
  db: D1Database,
  identity: InstanceIdentity,
  raw: unknown,
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
    addressed: accountIds(audience).filter((id) => !mentionedSet.has(id)),
  });
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
 * was fetched, or one whose row existed).
 *
 * `Updated` is an `Update` applied to a stored note. `added` are the local
 * accounts it newly mentions ({@link newlyMentionedAccountIds}, read before
 * the row was written). `edit` is the marker of a change to its content:
 * written by this delivery, or left by one whose late steps failed, which
 * this delivery finishes although the content it carries is already stored.
 * Absent for an `Update` that edits nothing, or whose pending edit another
 * delivery is finishing.
 */
export type LateSteps = Readonly<{
  actor: RemoteActor;
  raw: unknown;
  status: RemoteStatusValue;
  options: PersistOptions;
}> &
  (
    | Readonly<{ kind: "Created"; marker: HeldOwed | undefined }>
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
 * The accounts among `mentioned` to notify of their mention. A note an inbox
 * activity stored notifies all of them. An `Update` notifies the ones it
 * newly mentions, and the ones the edit it finishes did.
 */
const mentionsToNotify = (
  late: LateSteps,
  mentioned: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (late.kind === "Created") {
    return (late.options.delivery ?? "Fetched") === "Fetched" ? [] : mentioned;
  }
  const added = new Set([...late.added, ...(late.edit?.mentions ?? [])]);
  return mentioned.filter((accountId) => added.has(accountId));
};

/**
 * The steps of storing or updating a remote note that run after the batch
 * that writes its row: the mention rows, the mention notifications, the
 * direct conversation of a new note, the quote, the link card, the boosters'
 * `update` notifications of an edit and the stream events, then the deletion
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
  // The stream events come last. A redelivery that got this far before it
  // failed sends them again, and a client drops a status it already holds.
  // They are started here and run once the response is ready, best effort:
  // a page that fails goes to the queue, and nothing they do can fail the
  // delivery. So the marker stands for their start, not their end, and is
  // deleted below without waiting for them.
  const event = streamEvent(late);
  if (event !== undefined) {
    await startHomeFanOut(env, {
      event,
      entryId: status.id,
      author: { kind: "RemoteActor", actorUri: actor.actorUri },
    });
    if (status.visibility.kind === "Public") {
      await startPublicFanOut(env, { event, entryId: status.id });
    }
  }
  return clearOwed(env.DB, status.id, held ? [held] : []);
};

type RecipientStep = "Mention" | "Conversation";

/**
 * Notify `recipients.mention` of their mention of the stored note `status`,
 * and tell `recipients.conversation` their conversation changed. The first
 * {@link INLINE_NOTE_RECIPIENTS} accounts are served here; each of the rest
 * gets a `FinishRemoteNoteRecipient` job, which does the same for it. A
 * notification is stored once (`notifyFromRemoteOnce`), so a redelivery that
 * queues an account again notifies it once.
 */
const reachRecipients = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  status: RemoteStatusValue,
  recipients: Readonly<{
    mention: ReadonlyArray<string>;
    conversation: ReadonlyArray<string>;
  }>,
): Promise<Result<void, RepositoryError>> => {
  const steps = new Map<string, RecipientStep[]>();
  const add = (step: RecipientStep) => (accountId: string) => {
    steps.set(accountId, [...(steps.get(accountId) ?? []), step]);
  };
  recipients.mention.forEach(add("Mention"));
  recipients.conversation.forEach(add("Conversation"));
  const ordered = [...steps];
  const inline = ordered.slice(0, INLINE_NOTE_RECIPIENTS);
  const queued = ordered.slice(INLINE_NOTE_RECIPIENTS);
  const served = await serveRecipients(env, identity, actor.actorUri, status, inline);
  if (served.isErr()) {
    return err(served.error);
  }
  return queueRecipients(
    env,
    queued.map(([accountId, accountSteps]) => ({
      kind: "FinishRemoteNoteRecipient",
      statusId: status.id,
      actorUri: actor.actorUri,
      accountId,
      steps: accountSteps,
    })),
  );
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
  return ok(undefined);
};

/** Workers Queues takes at most 100 messages in one `sendBatch`. */
const SEND_BATCH_LIMIT = 100;

const queueRecipients = async (
  env: Env,
  jobs: ReadonlyArray<Extract<OutboxJob, { kind: "FinishRemoteNoteRecipient" }>>,
): Promise<Result<void, RepositoryError>> => {
  for (let start = 0; start < jobs.length; start += SEND_BATCH_LIMIT) {
    try {
      await env.OUTBOX_PROCESS_QUEUE.sendBatch(
        jobs.slice(start, start + SEND_BATCH_LIMIT).map((body) => ({ body })),
      );
    } catch (cause) {
      // Unqueued: the delivery fails and its redelivery queues them again.
      return err(
        toRepositoryError(
          `queueing note recipients failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
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
  const served = await serveRecipients(env, identity.value, job.actorUri, status, [
    [job.accountId, job.steps],
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
  const addressees = await localAddressees(env.DB, identity, raw);
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
  // Mention rows exist before the notifications that point at them. They are
  // sent before the later writes: an `Update` that edits nothing owes no
  // marker, so its redelivery finds the rows and would notify nobody.
  const reached = await reachRecipients(env, identity, actor, status, {
    mention: mentionsToNotify(late, mentioned),
    // Everyone a new direct note reaches here: the conversation lists it for each.
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
  startLinkCard(env, "RemoteStatus", status.id, status.contentHtml);
  if (late.kind === "Updated" && late.edit) {
    // As Mastodon's UpdateStatusService: local accounts that boosted the note hear it changed.
    // Quotes are skipped: a local account cannot yet quote a remote status.
    // Once per edit: a notification stored since the edit's marker is this edit's.
    const boosters = await listLocalBoosterAccountIds(env.DB, StatusTarget.remote(status.id));
    if (boosters.isErr()) {
      return err(boosters.error);
    }
    for (const accountId of boosters.value) {
      const sent = await notifyFromRemoteOnce(
        env,
        { accountId, actorUri: actor.actorUri, kind: "update", statusId: status.id },
        late.edit.createdAt,
      );
      if (sent.isErr()) {
        return err(sent.error);
      }
    }
  }
  return ok(undefined);
};

/**
 * The stream event the finished note is sent with, if any. An edit is
 * `status.update`. A new note is `update` when an inbox activity stored it
 * (it has a marker) and it was published recently, as Mastodon's
 * `Status::REAL_TIME_WINDOW`: an old note arriving late would show up in
 * clients as a new status. A `QuoteRequest` streams the note it stores as a
 * `Create` does: Mastodon runs its instrument as a `Create`
 * (`FetchRemoteStatusService`), which distributes it, and the `Create` that
 * follows finds the status and distributes nothing. A marker read back on a
 * redelivery counts as stored now: the delivery that wrote it never got
 * this far, so the note was not streamed.
 */
const streamEvent = (late: LateSteps): "update" | "status.update" | undefined => {
  if (late.kind === "Updated") {
    return late.edit ? "status.update" : undefined;
  }
  return late.marker !== undefined && RealtimeWindow.contains(late.status.publishedAt, nowInstant())
    ? "update"
    : undefined;
};

type PersistOptions = FederatedFetchOptions &
  Readonly<{
    /**
     * How the note arrives; `Fetched` by default. `Create` and `QuoteRequest`
     * are inbox activities its author signed, which the sender delivers again
     * after a 5xx: the local accounts a note stored from one mentions are
     * notified, and its late steps stay owed (`remote_status_owed`) until
     * they finish, so the redelivery resumes them. Either streams the note
     * as a new status.
     */
    delivery?: "Create" | "QuoteRequest" | "Fetched";
    /** Which instant a newly stored note's id sorts at; `Received` by default. */
    idClock?: IdClock;
    /**
     * How many quotes deep this note sits below the note that arrived (0 by
     * default); a note fetched as a quoted one is one deeper than its quoting
     * note. See {@link MAX_QUOTE_DEPTH}.
     */
    quoteDepth?: number;
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
      : await resolveRemoteActor(
          env.DB,
          identity,
          `${row.actorUri}#main-key`,
          row.actorUri,
          options,
        );
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
    return ok(cached.value.kind === "RemoteNote" ? cached.value : undefined);
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
 * is resolved first, as Mastodon's `FetchRemoteStatusService`. `undefined`
 * when the document is no note or the proof does not hold.
 */
export const storeNoteDocument = async (
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
  const author = await resolveRemoteActor(
    env.DB,
    identity,
    `${authorUri}#main-key`,
    authorUri,
    options,
  );
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
  const author = await resolveRemoteActor(
    env.DB,
    identity,
    `${embedded.vouchedBy}#main-key`,
    embedded.vouchedBy,
    options,
  );
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
  const nested: PersistOptions = { ...options, delivery: "Fetched", quoteDepth: depth + 1 };
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
  const status = await applyMediaPolicy(env, actor, parsed.value);
  const note = parseNoteDocument(raw);
  const inReplyTo = note.isOk() ? (note.value.inReplyTo ?? undefined) : undefined;
  const read = await cachedRemoteStatus(env, identity, status.objectUri, known);
  if (read.isErr()) {
    return err(read.error);
  }
  if (read.value && read.value.kind !== "RemoteNote") {
    return ok(undefined);
  }
  const existing: KnownRemoteStatus = { objectUri: status.objectUri, row: read.value };
  // A note an inbox activity stores owes its late steps until they finish.
  const marker =
    existing.row === undefined && (options.delivery ?? "Fetched") !== "Fetched"
      ? newOwedMarker("Created")
      : undefined;
  const stored = await upsertRemoteStatus(
    env.DB,
    status,
    noteHashtags(raw),
    inReplyTo,
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
  const finished = await finishRemoteNote(env, identity, {
    kind: "Created",
    actor,
    raw,
    status: stored.value,
    options,
    marker,
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
  if ((options.delivery ?? "Fetched") === "Fetched" || status.actorUri !== actor.actorUri) {
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
  return finishRemoteNote(env, identity, {
    kind: "Created",
    actor,
    raw,
    status,
    options,
    marker: held.value,
  });
};
