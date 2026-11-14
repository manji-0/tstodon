import {
  InstanceIdentity,
  RealtimeWindow,
  StatusTarget,
  type RemoteActor,
  type RemoteStatus as RemoteStatusValue,
  type MentionedPost,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { nowInstant } from "./clock";
import { readableRow, type RepositoryError } from "./d1";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { resolveRemoteActor } from "./remote-actor-fetch";
import type { IdClock } from "./ids";
import { parseLocalActorUsername, parseLocalStatusId } from "./activitypub";
import { findAccountByUsername } from "./account-store";
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
  type LateStepsInFlight,
  listOwed,
  newOwedMarker,
  owedStatement,
  releaseOwed,
} from "./remote-status-owed";
import { findThreadParent } from "./thread-context";
import { settleInvalidRemoteStatus } from "./remote-status-heal";
import {
  findDeliveredRemoteStatus,
  type InvalidRemoteStatusRow,
  type KnownRemoteStatus,
  upsertRemoteStatus,
} from "./remote-status-store";
import { publishConversationUpdate } from "./conversation-stream";
import {
  isActiveRemoteStatusMention,
  recordRemoteStatusMentions,
  replaceRemoteStatusRemoteMentions,
} from "./mention-store";
import { listLocalBoosterAccountIds } from "./status-interaction-store";
import { stringList } from "./form-values";
import { type EmbeddedQuoted, type RemoteQuoteContext, syncRemoteQuote } from "./remote-quote";

const MentionTagsSchema = z.object({
  tag: z
    .array(z.object({ type: z.string().optional(), href: z.string().optional() }).passthrough())
    .optional(),
});

/** The `href` of each `Mention` tag of a note document. */
const mentionHrefs = (raw: unknown): string[] => {
  const tags = schemaResult(MentionTagsSchema)(raw);
  return (tags.isOk() ? (tags.value.tag ?? []) : []).flatMap((entry) =>
    entry.type === "Mention" && entry.href ? [entry.href] : [],
  );
};

/**
 * Local accounts a remote note addresses: its `Mention` tags plus its
 * `to`/`cc` audience, kept to exact local actor URLs.
 */
const mentionedLocalUsernames = (identity: InstanceIdentity, raw: unknown): string[] => {
  const note = parseNoteDocument(raw);
  const candidates = [
    ...mentionHrefs(raw),
    ...(note.isOk() ? [...stringList(note.value.to), ...stringList(note.value.cc)] : []),
  ];
  return [
    ...new Set(
      candidates.flatMap((uri) => {
        const username = parseLocalActorUsername(identity, uri);
        return username && InstanceIdentity.actorUrl(identity, username) === uri ? [username] : [];
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
 * Record the local accounts a newly stored remote note addresses, so it can
 * reach their conversations, and notify them when asked.
 */
const mentionedLocalAccountIds = async (
  env: Env,
  identity: InstanceIdentity,
  raw: unknown,
): Promise<string[]> => {
  const accountIds: string[] = [];
  for (const username of mentionedLocalUsernames(identity, raw)) {
    const account = await findAccountByUsername(env.DB, username);
    if (account.isOk() && account.value) {
      accountIds.push(account.value.id);
    }
  }
  return accountIds;
};

/**
 * The `MentionedPost` of a stored remote note: the local accounts it
 * addresses, the actors its `Mention` tags name, and the author of the
 * stored status it replies to.
 */
const remoteMentionedPost = async (
  db: D1Database,
  identity: InstanceIdentity,
  raw: unknown,
  status: RemoteStatusValue,
  localAccountIds: ReadonlyArray<string>,
): Promise<MentionedPost> => {
  // The note is already stored: a failed parent read screens without the
  // parent author rather than failing the delivery after its writes.
  const parent = await findThreadParent(db, identity, { kind: "Remote", status });
  return mentionedPost(
    [...localAccountIds, ...mentionHrefs(raw)],
    parent.isOk() ? parent.value : undefined,
  );
};

/**
 * What {@link finishRemoteNote} finishes: the note `actor` wrote, as stored
 * (`status`) and as delivered or fetched (`raw`).
 *
 * `Created` is a note stored from `raw`. `marker` is the one written with its
 * row, absent for a note that owes nothing (one that was fetched, or one
 * whose row existed). It is `resumed` when another delivery wrote it and
 * this one finishes its steps. Either way this delivery holds its lease.
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
    | Readonly<{ kind: "Created"; marker: HeldOwed | undefined; resumed: boolean }>
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
): Promise<ReadonlyArray<string>> => {
  const added: string[] = [];
  for (const accountId of await mentionedLocalAccountIds(env, identity, raw)) {
    const already = await isActiveRemoteStatusMention(env.DB, statusId, accountId);
    if (already.isOk() && !already.value) {
      added.push(accountId);
    }
  }
  return added;
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
 * given back when they fail or leave the marker, so the next delivery takes
 * it at once. A delivery that was cut off gives nothing back: its lease
 * expires, and until then a `Create` of the note is asked to come again.
 */
export const finishRemoteNote = async (
  env: Env,
  identity: InstanceIdentity,
  late: LateSteps,
): Promise<Result<void, RepositoryError>> => {
  const held = late.kind === "Created" ? late.marker : late.edit;
  const finished = await runLateSteps(env, identity, late);
  if (held !== undefined && (finished.isErr() || finishedMarker(late) === undefined)) {
    // Best effort: a lease that is not given back expires.
    await releaseOwed(env.DB, late.status.id, held);
  }
  return finished;
};

const runLateSteps = async (
  env: Env,
  identity: InstanceIdentity,
  late: LateSteps,
): Promise<Result<void, RepositoryError>> => {
  const { actor, raw, status, options } = late;
  const mentioned = await mentionedLocalAccountIds(env, identity, raw);
  const notified = mentionsToNotify(late, mentioned);
  const recorded = await recordRemoteStatusMentions(env.DB, status.id, mentioned);
  if (recorded.isErr()) {
    return err(recorded.error);
  }
  // Mention rows exist before the notifications that point at them. They are
  // sent before the later writes: an `Update` that edits nothing owes no
  // marker, so its redelivery finds the rows and would notify nobody.
  if (notified.length > 0) {
    const post = await remoteMentionedPost(env.DB, identity, raw, status, mentioned);
    for (const accountId of notified) {
      const sent = await notifyFromRemoteOnce(
        env,
        { accountId, actorUri: actor.actorUri, kind: "mention", statusId: status.id },
        undefined,
        post,
      );
      if (sent.isErr()) {
        return err(sent.error);
      }
    }
  }
  const remote = await replaceRemoteStatusRemoteMentions(
    env.DB,
    status.id,
    mentionedRemoteActorUris(identity, raw),
  );
  if (remote.isErr()) {
    return err(remote.error);
  }
  if (late.kind === "Created" && status.visibility.kind === "Direct") {
    await publishConversationUpdate(env, identity, mentioned, status.id);
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
  const finished = finishedMarker(late);
  return clearOwed(env.DB, status.id, finished ? [finished] : []);
};

/**
 * The marker these steps leave nothing owed for. A `Created` marker that a
 * `QuoteRequest` resumes is not one: it cannot tell whether a `Create` wrote
 * it, which still owes the stream events, so it runs the other steps and
 * leaves the marker to the `Create`'s redelivery, or to the sweep.
 */
const finishedMarker = (late: LateSteps): HeldOwed | undefined => {
  if (late.kind === "Updated") {
    return late.edit;
  }
  return late.resumed && late.options.delivery !== "Create" ? undefined : late.marker;
};

/**
 * The stream event the finished note is sent with, if any. An edit is
 * `status.update`. A new note is `update` when a `Create` stored it and it
 * was published recently, as Mastodon's `Status::REAL_TIME_WINDOW`: an old
 * note arriving late would show up in clients as a new status. A marker read
 * back on a redelivery counts as stored now: the delivery that wrote it
 * never got this far, so the note was not streamed.
 */
const streamEvent = (late: LateSteps): "update" | "status.update" | undefined => {
  if (late.kind === "Updated") {
    return late.edit ? "status.update" : undefined;
  }
  return late.marker !== undefined &&
    late.options.delivery === "Create" &&
    RealtimeWindow.contains(late.status.publishedAt, nowInstant())
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
     * they finish, so the redelivery resumes them. A `Create` also streams
     * the note as a new status.
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

/**
 * The note `actor` wrote, stored or found cached. An inbox activity that
 * carries it (`options.delivery`) also finishes the late steps the note is
 * owed. `LateStepsInFlight` is a `Create` of a note whose steps another
 * delivery holds: see {@link resumeCreated}.
 */
export const persistRemoteObject = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  object: ObjectReference,
  options: PersistOptions,
  known?: KnownRemoteStatus,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError | LateStepsInFlight>> => {
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
      return storeFetchedNote(env, identity, announcer, object, options, {
        objectUri,
        row: undefined,
      });
    }
  }
  const raw = await fetchActivityJson(identity, objectUri, options);
  if (raw.isErr()) {
    return ok(undefined);
  }
  const note = parseNoteDocument(raw.value);
  if (note.isErr() || note.value.id !== objectUri) {
    return ok(undefined);
  }
  const authorUri = note.value.attributedTo;
  if (authorUri === announcer.actorUri) {
    return storeFetchedNote(env, identity, announcer, raw.value, options);
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
  return storeFetchedNote(env, identity, author.value, raw.value, options);
};

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
    return storeFetchedNote(env, identity, actor, embedded.object, options);
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
  return storeFetchedNote(env, identity, author.value, embedded.object, options);
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
): Promise<Result<RemoteStatusValue | undefined, RepositoryError | LateStepsInFlight>> => {
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
    resumed: false,
  });
  return finished.map(() => stored.value);
};

/**
 * {@link storeRemoteNote} for a note no inbox activity of its author carries:
 * one that was fetched, announced or vouched for. It resumes no late steps,
 * so they are never another delivery's.
 */
const storeFetchedNote = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  raw: unknown,
  options: PersistOptions,
  known?: KnownRemoteStatus,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const fetched: PersistOptions = { ...options, delivery: "Fetched" };
  const stored = await storeRemoteNote(env, identity, actor, raw, fetched, known);
  return stored.orElse((error) =>
    error.kind === "LateStepsInFlight" ? ok(undefined) : err(error),
  );
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
): Promise<Result<RemoteStatusValue | undefined, RepositoryError | LateStepsInFlight>> => {
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
 * Finish what the delivery that stored `status` left owed, when `actor`
 * wrote the note and delivers it again in an inbox activity. The stored row
 * is kept as it is; only the late steps run, from the document delivered
 * now. A note edited since is left alone: the `Update` wrote its mentions
 * and quote from a newer document than a `Create` carries, so the marker
 * stays until the sweep deletes it.
 *
 * Only the delivery that gets the marker's lease runs the steps
 * ({@link claimOwed}). One that does not goes without them. A `QuoteRequest`
 * then goes on: the marker stays, and is not its to finish. A `Create` is
 * `LateStepsInFlight`, answered 503 with `Retry-After`, not 202: the holder
 * may be a `QuoteRequest`, which leaves the stream event to a `Create`, or
 * may fail, and a `Create` answered 202 does not come again. When it does
 * come again the marker is gone, or its lease was given back or has expired.
 */
const resumeCreated = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  /** The note's document, or its URI, which is fetched. */
  object: unknown,
  status: RemoteStatusValue,
  options: PersistOptions,
): Promise<Result<void, RepositoryError | LateStepsInFlight>> => {
  if ((options.delivery ?? "Fetched") === "Fetched" || status.actorUri !== actor.actorUri) {
    return ok(undefined);
  }
  const owed = await listOwed(env.DB, status.id);
  if (owed.isErr()) {
    return err(owed.error);
  }
  const marker = owed.value.find((entry) => entry.kind === "Created");
  if (marker === undefined || status.editedAt.kind === "Edited") {
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
  if (noteFromUnknown(raw, actor).isErr()) {
    return ok(undefined);
  }
  const held = await claimOwed(env.DB, status.id, marker);
  if (held.isErr()) {
    return err(held.error);
  }
  if (held.value === undefined) {
    return options.delivery === "Create" ? err({ kind: "LateStepsInFlight" }) : ok(undefined);
  }
  return finishRemoteNote(env, identity, {
    kind: "Created",
    actor,
    raw,
    status,
    options,
    marker: held.value,
    resumed: true,
  });
};
