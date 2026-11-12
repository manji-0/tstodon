import { schemaResult } from "@tstodon/core";
import {
  type InstanceIdentity,
  QuotedTarget,
  type QuotedTargetValue,
  type QuoteState,
  type QuoteValue,
  type RemoteStatusValue,
  StatusTarget,
  type StatusTargetValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { parseLocalStatusId } from "./activitypub";
import { JsonObjectSchema, refId } from "./activitypub-wire";
import { nowInstant } from "./clock";
import { readableRow, type RepositoryError } from "./d1";
import type { FederatedFetchOptions } from "./federated-fetch";
import { newEntityId } from "./ids";
import {
  deleteQuoteByQuoting,
  findQuoteByQuoting,
  insertStatusQuote,
  saveQuoteState,
} from "./quote-store";
import {
  fetchStamp,
  type StampFetch,
  stampQuotedObject,
  unresolvedQuoteState,
  verifyRemoteQuote,
} from "./remote-quote-verify";
import { findStatusById, readStatusById } from "./status-store";
import { findAccountById } from "./account-store";
import { federateStampDeletion } from "./quote-stamp-revoke";
import { enqueueQuoteRefetch, type QuoteRefetch } from "./quote-retry-queue";

/** The keys a note may name its quoted status by, in Mastodon's order; all but `quote` predate FEP-044f. */
const QUOTE_KEYS = ["quote", "_misskey_quote", "quoteUrl", "quoteUri"] as const;

/**
 * The status a note quotes, as Mastodon's `StatusParser#quote_uri`. `legacy`
 * when no `quote` key names it, as `legacy_quote?`. `embedded` is the object
 * `quote` inlines, when it does (`quoted_object`; only `quote` may be
 * inlined), a Tombstone included: it is untrusted until checked.
 * `approvalUri` is the first `quoteAuthorization`, by id when inlined.
 */
export type NoteQuoteRef = Readonly<{
  uri: string;
  legacy: boolean;
  embedded: Readonly<Record<string, unknown>> | undefined;
  approvalUri: string | undefined;
}>;

const parseJsonObject = schemaResult(JsonObjectSchema);

export const noteQuoteRef = (raw: unknown): NoteQuoteRef | undefined => {
  const document = parseJsonObject(raw);
  if (document.isErr()) {
    return undefined;
  }
  const uri = QUOTE_KEYS.map((key) => refId(document.value[key])).find((id) => id !== undefined);
  if (uri === undefined) {
    return undefined;
  }
  const quote = document.value["quote"];
  const embedded = parseJsonObject(Array.isArray(quote) ? quote[0] : quote);
  return {
    uri,
    legacy: !Object.hasOwn(document.value, "quote"),
    embedded: embedded.isOk() ? embedded.value : undefined,
    approvalUri: refId(document.value["quoteAuthorization"]),
  };
};

/**
 * A copy of a quoted note that arrived inlined, and the actor whose server
 * sent it: the quoting author for a `quote` object, the stamp's author for a
 * stamp's `interactionTarget`. It is stored only when it is that actor's own
 * note on that actor's host; anything else is fetched by its id.
 */
export type EmbeddedQuoted = Readonly<{
  object: Readonly<Record<string, unknown>>;
  vouchedBy: string;
}>;

/** How a quote of a remote status reaches the network: its quoted note and its stamp. */
export type RemoteQuoteContext = Readonly<{
  /**
   * The cached remote status at `uri`, else stored from `embedded` or
   * fetched, when the quote depth allows it.
   */
  resolveQuoted: (
    uri: string,
    embedded?: EmbeddedQuoted,
  ) => Promise<Result<RemoteStatusValue | undefined, RepositoryError>>;
  /**
   * Whether this note may still reach the network for its quote (Mastodon's
   * `MAX_SYNCHRONOUS_DEPTH`): past the depth limit, an uncached quoted note
   * stays unresolved and its stamp is not fetched.
   */
  mayFetch: boolean;
  fetchOptions: FederatedFetchOptions;
}>;

const forget = async (
  db: D1Database,
  quoting: StatusTargetValue,
  existing: QuoteValue | undefined,
): Promise<Result<void, RepositoryError>> =>
  existing ? deleteQuoteByQuoting(db, quoting) : ok(undefined);

const newQuote = (
  quoting: StatusTargetValue,
  quoted: QuotedTargetValue,
  state: QuoteState,
  legacy: boolean,
): QuoteValue => ({
  id: newEntityId(),
  quoting,
  quoted,
  state,
  legacy,
  createdAt: nowInstant(),
});

/**
 * A quote of a local status. The same quoted status keeps its state: our
 * acceptance is authoritative, so the note's `quoteAuthorization` is not
 * read. A new quoted status starts over as `Pending`, until its author
 * answers a `QuoteRequest`.
 */
const syncLocalQuoted = async (
  db: D1Database,
  quoting: StatusTargetValue,
  existing: QuoteValue | undefined,
  ref: NoteQuoteRef,
  quotedId: string,
): Promise<Result<void, RepositoryError>> => {
  const kept = existing?.quoted;
  if (kept?.kind === "LocalStatus" && kept.statusId === quotedId) {
    return ok(undefined);
  }
  const forgotten = await forget(db, quoting, existing);
  if (forgotten.isErr()) {
    return forgotten;
  }
  // A quoted local note whose row does not read is no note to quote.
  const quoted = readableRow(await readStatusById(db, quotedId));
  if (quoted.isErr()) {
    return err(quoted.error);
  }
  if (quoted.value?.kind !== "LocalNote") {
    return ok(undefined);
  }
  return insertStatusQuote(
    db,
    newQuote(quoting, StatusTarget.local(quoted.value.id), { kind: "Pending" }, ref.legacy),
  );
};

/** Whether `uri` may name a remote quoted note: http(s), and not on this instance. */
const isRemoteNoteUri = (identity: InstanceIdentity, uri: string): boolean => {
  try {
    const url = new URL(uri);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.host.toLowerCase() !== new URL(identity.publicOrigin).host.toLowerCase()
    );
  } catch {
    return false;
  }
};

/**
 * The quoted note and, when it took fetching the stamp to find it, that
 * fetch. The note is the cached one, the note's inlined `quote` object, or
 * fetched (`resolveQuoted`). When none resolves, a stamp whose
 * `interactionTarget` inlines the quoted note may still supply it, as
 * Mastodon's `VerifyQuoteService` fetches the quoted post the approval names.
 */
const resolveQuotedNote = async (
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  ref: NoteQuoteRef,
  context: RemoteQuoteContext,
): Promise<
  Result<
    Readonly<{ quoted: RemoteStatusValue | undefined; stamp: StampFetch | undefined }>,
    RepositoryError
  >
> => {
  const embedded = ref.embedded && { object: ref.embedded, vouchedBy: status.actorUri };
  const quoted = await context.resolveQuoted(ref.uri, embedded);
  if (quoted.isErr() || quoted.value || !context.mayFetch) {
    return quoted.map((value) => ({ quoted: value, stamp: undefined }));
  }
  const stamp = await fetchStamp(identity, ref.approvalUri, context.fetchOptions);
  const inlined = stampQuotedObject(stamp, { quotingUri: status.objectUri, quotedUri: ref.uri });
  if (!inlined) {
    return ok({ quoted: undefined, stamp });
  }
  const fromStamp = await context.resolveQuoted(ref.uri, {
    object: inlined.object,
    vouchedBy: inlined.authorUri,
  });
  return fromStamp.map((value) => ({ quoted: value, stamp }));
};

/**
 * Whether a quote of the same remote status keeps its state: the quoted
 * author revoked it, it is a self-quote, or it was accepted on the stamp the
 * note still names.
 */
const keepsState = (state: QuoteState, approvalUri: string | undefined): boolean => {
  switch (state.kind) {
    case "Revoked":
      return true;
    case "Accepted":
      return state.approval.kind === "Implicit" || state.approval.uri === approvalUri;
    default:
      return false;
  }
};

/**
 * What syncing a quote of a remote status did: whether it changed the
 * quote's state or quoted note (`changed`), and the quote to check again
 * later (`refetch`), when it is left pending because the quoted note did
 * not resolve or the stamp could not be fetched for now.
 */
export type RemoteQuoteSync = Readonly<{
  changed: boolean;
  refetch: QuoteRefetch | undefined;
}>;

const UNCHANGED: RemoteQuoteSync = { changed: false, refetch: undefined };

/**
 * A quote of a remote status, verified with {@link verifyRemoteQuote}. A
 * quoted note that cannot be found or fetched keeps the quote unresolved and
 * pending (rejected when its stamp does not resolve), as Mastodon keeps a
 * quote with no `quoted_status`; the note's next `Update` tries
 * again, and a quote resolved that way keeps its id. A changed stamp, or a
 * quote not yet accepted, is verified again; a changed quoted note starts
 * over under a new quote id.
 *
 * A quote left pending with its quoted note unresolved (whether the fetch
 * failed or the quote depth allowed none, Mastodon's
 * `RecursionLimitExceededError`), or with a stamp fetch that failed for
 * now, is to be checked again (`refetch`), as Mastodon's
 * `fetch_and_verify_quote` queues `RefetchAndVerifyQuoteWorker`.
 */
const syncRemoteQuoted = async (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  existing: QuoteValue | undefined,
  ref: NoteQuoteRef,
  context: RemoteQuoteContext,
): Promise<Result<RemoteQuoteSync, RepositoryError>> => {
  const quoting = StatusTarget.remote(status.id);
  if (!isRemoteNoteUri(identity, ref.uri)) {
    return (await forget(env.DB, quoting, existing)).map(() => ({
      changed: existing !== undefined,
      refetch: undefined,
    }));
  }
  const resolved = await resolveQuotedNote(identity, status, ref, context);
  if (resolved.isErr()) {
    return err(resolved.error);
  }
  const { quoted } = resolved.value;
  const target = quoted ? StatusTarget.remote(quoted.id) : QuotedTarget.unresolved(ref.uri);
  const unchanged = existing !== undefined && QuotedTarget.equals(existing.quoted, target);
  const resolving =
    existing?.quoted.kind === "Unresolved" &&
    existing.quoted.uri === ref.uri &&
    quoted !== undefined;
  const same = unchanged || resolving ? existing : undefined;
  if (same && unchanged && same.legacy === ref.legacy && keepsState(same.state, ref.approvalUri)) {
    return ok(UNCHANGED);
  }
  // The stamp is fetched here rather than in `verifyRemoteQuote`, so a
  // temporary failure can be told apart from a stamp that does not match.
  const stamp =
    quoted && quoted.actorUri !== status.actorUri && resolved.value.stamp === undefined
      ? await fetchStamp(identity, ref.approvalUri, context.fetchOptions)
      : resolved.value.stamp;
  const state = quoted
    ? await verifyRemoteQuote(
        identity,
        { quoting: status, quoted, approvalUri: ref.approvalUri },
        context.fetchOptions,
        stamp,
      )
    : unresolvedQuoteState(stamp ?? { kind: "None" });
  const id = same?.id ?? newEntityId();
  const retry = state.kind === "Pending" && (quoted === undefined || stamp?.kind === "Unavailable");
  const outcome: RemoteQuoteSync = {
    changed: same === undefined || !resolvedSameState(same, target, state),
    refetch: retry ? { quoteId: id, quotedUri: ref.uri, approvalUri: ref.approvalUri } : undefined,
  };
  if (same) {
    return (
      await saveQuoteState(env.DB, { ...same, quoted: target, state, legacy: ref.legacy })
    ).map(() => outcome);
  }
  const forgotten = await forget(env.DB, quoting, existing);
  if (forgotten.isErr()) {
    return err(forgotten.error);
  }
  return (
    await insertStatusQuote(env.DB, { ...newQuote(quoting, target, state, ref.legacy), id })
  ).map(() => outcome);
};

/** Whether `quote` already names `target` in `state`, so a sync to them changes nothing visible. */
const resolvedSameState = (
  quote: QuoteValue,
  target: QuotedTargetValue,
  state: QuoteState,
): boolean => QuotedTarget.equals(quote.quoted, target) && sameState(quote.state, state);

const approvalUri = (state: QuoteState): string | undefined =>
  state.kind === "Accepted" && state.approval.kind === "Stamp" ? state.approval.uri : undefined;

const sameState = (a: QuoteState, b: QuoteState): boolean =>
  a.kind === b.kind && approvalUri(a) === approvalUri(b);

/**
 * Check a pending quote by a remote note again, as Mastodon's
 * `RefetchAndVerifyQuoteWorker` runs `VerifyQuoteService`: the quoted note
 * `quotedUri` is resolved (fetched when not cached) and the stamp
 * `approvalUri` fetched and verified. The caller has checked that the quote
 * is still pending and still names `quotedUri`.
 */
export const reverifyRemoteQuote = (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  quote: QuoteValue,
  refetch: Readonly<{ quotedUri: string; approvalUri: string | undefined }>,
  context: RemoteQuoteContext,
): Promise<Result<RemoteQuoteSync, RepositoryError>> =>
  syncRemoteQuoted(
    env,
    identity,
    status,
    quote,
    {
      uri: refetch.quotedUri,
      legacy: quote.legacy,
      embedded: undefined,
      approvalUri: refetch.approvalUri,
    },
    context,
  );

/**
 * Keep the quote a cached remote note makes in step with its document, as
 * Mastodon's `update_quote!` and `VerifyQuoteService`. A note that quotes
 * nothing keeps no quote. A legacy quote (`_misskey_quote`, `quoteUrl`,
 * `quoteUri` with no `quote`) is stored as any other, with `legacy` set:
 * Mastodon never shows one until it is accepted, and for a local status a
 * `QuoteRequest` accepts it.
 */
const reconcileRemoteQuote = async (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  raw: unknown,
  context: RemoteQuoteContext,
): Promise<Result<QuoteRefetch | undefined, RepositoryError>> => {
  const quoting = StatusTarget.remote(status.id);
  const existing = await findQuoteByQuoting(env.DB, quoting);
  if (existing.isErr()) {
    return err(existing.error);
  }
  const ref = noteQuoteRef(raw);
  const quotedId = ref && parseLocalStatusId(identity, ref.uri);
  if (ref && quotedId !== undefined) {
    return (await syncLocalQuoted(env.DB, quoting, existing.value, ref, quotedId)).map(
      () => undefined,
    );
  }
  if (ref) {
    return (await syncRemoteQuoted(env, identity, status, existing.value, ref, context)).map(
      (synced) => synced.refetch,
    );
  }
  return (await forget(env.DB, quoting, existing.value)).map(() => undefined);
};

/**
 * Withdraw the stamp of an accepted quote of a local status that the note no
 * longer makes (`before` is the quote before the sync, `after` what the sync
 * left), as Mastodon's `update_quote!` runs `RevokeQuoteService` when the
 * quoted status changes. A note that drops its quote is revoked the same
 * way, where Mastodon only destroys the quote, so the servers that saw the
 * stamp hear it is gone. The quote row itself is already replaced or gone.
 */
const withdrawDroppedStamp = async (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  before: QuoteValue | undefined,
  after: QuoteValue | undefined,
): Promise<void> => {
  if (
    before?.quoted.kind !== "LocalStatus" ||
    before.state.kind !== "Accepted" ||
    after?.id === before.id
  ) {
    return;
  }
  const quoted = await findStatusById(env.DB, before.quoted.statusId);
  if (quoted.isErr() || quoted.value === undefined) {
    return;
  }
  const author = await findAccountById(env.DB, quoted.value.accountId);
  if (author.isErr() || author.value === undefined) {
    return;
  }
  await federateStampDeletion(
    env,
    identity,
    author.value,
    quoted.value,
    { kind: "RemoteStatus", status },
    before.id,
  );
};

/**
 * {@link reconcileRemoteQuote}, then {@link withdrawDroppedStamp} when an
 * accepted quote of a local status went away with the edit. A quote of a
 * remote status left to check again is queued for its first refetch.
 */
export const syncRemoteQuote = async (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  raw: unknown,
  context: RemoteQuoteContext,
): Promise<Result<void, RepositoryError>> => {
  const quoting = StatusTarget.remote(status.id);
  const before = await findQuoteByQuoting(env.DB, quoting);
  if (before.isErr()) {
    return err(before.error);
  }
  const synced = await reconcileRemoteQuote(env, identity, status, raw, context);
  if (synced.isErr()) {
    return err(synced.error);
  }
  if (synced.value) {
    await enqueueQuoteRefetch(env, synced.value, 1);
  }
  const accepted =
    before.value?.quoted.kind === "LocalStatus" && before.value.state.kind === "Accepted";
  if (accepted) {
    const after = await findQuoteByQuoting(env.DB, quoting);
    if (after.isOk()) {
      await withdrawDroppedStamp(env, identity, status, before.value, after.value);
    }
  }
  return ok(undefined);
};
