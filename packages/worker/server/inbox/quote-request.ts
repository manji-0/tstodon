import type { ApActivityDocumentOf } from "@tstodon/api/activitypub";
import { schemaResult } from "@tstodon/core";
import {
  type InstanceIdentity,
  type LocalAccount,
  type LocalNote,
  Quote,
  type QuoteValue,
  type RemoteActor,
  type RemoteStatusValue,
  StatusTarget,
} from "@tstodon/domain";
import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import { availableAccountIds } from "../account-presentation";
import { findAccountById } from "../account-store";
import {
  type ActivityObjectRef,
  localNoteRef,
  parseLocalStatusId,
  type QuoteRequestRef,
  quoteRequestAnswerActivity,
} from "../activitypub";
import { refId } from "../activitypub-wire";
import { findBlock } from "../block-mute-store";
import { publishConversationUpdate } from "../conversation-stream";
import { readableRow, type RepositoryError } from "../d1";
import { enqueueTargetedActivity } from "../delivery";
import { isActorDomainBlocked } from "../domain-block-store";
import { announceRemoteQuoteChange } from "../remote-quote-announce";
import { newEntityId } from "../ids";
import { recordSilentRemoteStatusMention } from "../mention-store";
import { notifyFromRemote } from "../notify";
import { quoteAuthorizationUri } from "../quote-authorization-document";
import { loadNoteQuotePolicy } from "../quote-policy-name";
import { findQuoteByActivityUri, findQuoteByQuoting, saveQuoteState } from "../quote-store";
import { remoteFollowerActorUris } from "../remote-actor-store";
import { persistRemoteObject } from "../remote-status-persist";
import { findDeliveredRemoteStatus } from "../remote-status-store";
import { readStatusById } from "../status-store";
import { canViewRemoteStatus } from "../visibility-guard";
import type { RemoteDelivery } from "./handler";

const urlHost = (href: string): string | undefined => {
  try {
    return new URL(href).host.toLowerCase();
  } catch {
    return undefined;
  }
};

/** The local note a `QuoteRequest` asks to quote, with its author and URIs. */
type QuotedNote = Readonly<{ note: LocalNote; author: LocalAccount; ref: ActivityObjectRef }>;

/**
 * The note `object` names, when others may ask to quote it: a public or
 * unlisted local note, as Mastodon's `distributable?`.
 */
const quotedNote = async (
  db: D1Database,
  identity: InstanceIdentity,
  object: string,
): Promise<Result<QuotedNote | undefined, RepositoryError>> => {
  const id = parseLocalStatusId(identity, object);
  if (id === undefined) {
    return ok(undefined);
  }
  const note = readableRow(await readStatusById(db, id));
  if (note.isErr()) {
    return err(note.error);
  }
  const visibility = note.value?.kind === "LocalNote" ? note.value.visibility.kind : undefined;
  if (note.value?.kind !== "LocalNote" || (visibility !== "Public" && visibility !== "Unlisted")) {
    return ok(undefined);
  }
  const found = note.value;
  const author = await findAccountById(db, found.accountId);
  return author.map(
    (account) =>
      account && { note: found, author: account, ref: localNoteRef(identity, account, found.id) },
  );
};

/**
 * Whether the signer may quote the note, as Mastodon's `StatusPolicy#quote?`:
 * its author is available and blocks neither the signer nor its domain, and
 * the note's policy lets the signer in. As in Mastodon, a local policy is
 * automatic only (no local `manualApproval`), so the answer is always an
 * immediate `Accept` or `Reject`, never a pending request.
 */
const mayQuote = async (
  env: Env,
  { note, author }: QuotedNote,
  signer: RemoteActor,
): Promise<Result<boolean, RepositoryError>> => {
  const checks = Result.combine(
    await Promise.all([
      availableAccountIds(env, [author.id]),
      findBlock(env.DB, author.id, signer.actorUri),
      isActorDomainBlocked(env.DB, author.id, signer.actorUri),
    ]),
  );
  if (checks.isErr()) {
    return err(checks.error);
  }
  const [available, blocked, domainBlocked] = checks.value;
  if (!available.has(author.id) || blocked || domainBlocked) {
    return ok(false);
  }
  switch (await loadNoteQuotePolicy(env.DB, author, note)) {
    case "public":
      return ok(true);
    case "followers":
      return (await remoteFollowerActorUris(env.DB, author.id, [signer.actorUri])).map(
        (followers) => followers.has(signer.actorUri),
      );
    case "nobody":
      return ok(false);
  }
};

const InlineInstrumentSchema = z.object({ id: z.string().min(1) }).passthrough();

/**
 * The quoting note, cached. An embedded note on the signer's host is stored
 * as sent, as Mastodon's `import_instrument`; anything else is fetched. Either
 * way the note must be the signer's.
 */
const cacheInstrument = async (
  {
    env,
    identity,
    signer,
    received,
    allowHosts,
    blockedHosts,
    fetchSigner,
  }: RemoteDelivery<"QuoteRequest">,
  uri: string,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const inline = schemaResult(InlineInstrumentSchema)(received.instrument);
  const embedded =
    inline.isOk() && urlHost(inline.value.id) === urlHost(signer.actorUri) ? inline.value : uri;
  const stored = await persistRemoteObject(env, identity, signer, embedded, {
    allowHosts,
    blockedHosts,
    fetchSigner,
    // A `Create` that comes after finds the note cached and notifies nobody.
    delivery: "QuoteRequest",
  });
  return stored.map((status) => (status?.actorUri === signer.actorUri ? status : undefined));
};

/**
 * Let the quoted author see the quoting note, as Mastodon's
 * `Quote#ensure_quoted_access`: a silent mention, so a followers-only or
 * direct note reaches them and the quote notification can be sent, without
 * a mention notification of its own.
 */
const ensureQuotedAccess = async (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  accountId: string,
): Promise<Result<void, RepositoryError>> => {
  const recorded = await recordSilentRemoteStatusMention(env.DB, status.id, accountId);
  if (recorded.isErr()) {
    return recorded;
  }
  if (status.visibility.kind === "Direct") {
    await publishConversationUpdate(env, identity, [accountId], status.id);
  }
  return ok(undefined);
};

const sendAnswer = async (
  env: Env,
  author: LocalAccount,
  signer: RemoteActor,
  kind: "Accept" | "Reject",
  activity: ApActivityDocumentOf<"Accept" | "Reject">,
): Promise<void> => {
  const enqueued = await enqueueTargetedActivity(env, author.id, kind, activity, signer.inboxUri);
  if (enqueued.isErr()) {
    console.error(JSON.stringify({ kind: "QuoteRequestAnswerNotSent", answer: kind }));
  }
};

/** The quote `quoting` makes of `quoted`, when it has one. */
const quoteOf = async (
  db: D1Database,
  quoting: RemoteStatusValue | undefined,
  quoted: LocalNote,
): Promise<Result<QuoteValue | undefined, RepositoryError>> => {
  if (!quoting) {
    return ok(undefined);
  }
  const quote = await findQuoteByQuoting(db, StatusTarget.remote(quoting.id));
  return quote.map((found) =>
    found?.quoted.kind === "LocalStatus" && found.quoted.statusId === quoted.id ? found : undefined,
  );
};

/**
 * Whether another quote already holds the request id, as when another actor
 * on the signer's host reuses it. Such a request is dropped unanswered rather
 * than failing on the unique `activity_uri`.
 */
const requestIdTaken = async (
  db: D1Database,
  requestId: string,
  quote: QuoteValue,
): Promise<Result<boolean, RepositoryError>> =>
  (await findQuoteByActivityUri(db, requestId)).map(
    (holder) => holder !== undefined && holder.id !== quote.id,
  );

/**
 * Refuse the request, as Mastodon's `reject_quote_request!`, without
 * fetching the quoting note. A quote already stored is rejected, or revoked
 * when it was accepted.
 */
const rejectQuoteRequest = async (
  env: Env,
  quoted: QuotedNote,
  signer: RemoteActor,
  request: QuoteRequestRef,
): Promise<Result<void, RepositoryError>> => {
  const quoting = readableRow(await findDeliveredRemoteStatus(env.DB, request.instrument));
  if (quoting.isErr()) {
    return err(quoting.error);
  }
  const owned = quoting.value?.actorUri === signer.actorUri ? quoting.value : undefined;
  const quote = await quoteOf(env.DB, owned, quoted.note);
  if (quote.isErr()) {
    return err(quote.error);
  }
  if (owned && quote.value) {
    const taken = await requestIdTaken(env.DB, request.id, quote.value);
    if (taken.isErr() || taken.value) {
      return taken.map(() => undefined);
    }
    const rejected = Quote.reject({ ...quote.value, activityUri: request.id });
    const saved = await saveQuoteState(env.DB, rejected);
    if (saved.isErr()) {
      return err(saved.error);
    }
    if (rejected.state.kind !== quote.value.state.kind) {
      await announceRemoteQuoteChange(env, owned);
    }
  }
  await sendAnswer(
    env,
    quoted.author,
    signer,
    "Reject",
    quoteRequestAnswerActivity(
      { kind: "Reject" },
      quoted.ref.authorUri,
      quote.value?.id ?? newEntityId(),
      request,
    ),
  );
  return ok(undefined);
};

/**
 * A remote actor asks to quote a local note, as Mastodon's
 * `QuoteRequest#perform`. A request for a note others may not quote, or whose
 * id is not on the signer's host, is dropped without an answer. Otherwise the
 * author's policy decides: an `Accept` carries the stamp as `result`, accepts
 * the stored quote and notifies the author when they may see the quoting
 * note; a `Reject` refuses it.
 */
export const receiveQuoteRequest = async (
  delivery: RemoteDelivery<"QuoteRequest">,
): Promise<Result<void, RepositoryError>> => {
  const { env, identity, signer, activity, received } = delivery;
  if (urlHost(activity.id) !== urlHost(signer.actorUri)) {
    return ok(undefined);
  }
  const quoted = await quotedNote(env.DB, identity, activity.object);
  if (quoted.isErr() || quoted.value === undefined) {
    return quoted.map(() => undefined);
  }
  const instrument = refId(received.instrument);
  if (instrument === undefined) {
    return ok(undefined);
  }
  const quotedRef = quoted.value.ref;
  const request: QuoteRequestRef = {
    id: activity.id,
    actor: signer.actorUri,
    object: quotedRef.uri,
    instrument,
  };
  const allowed = await mayQuote(env, quoted.value, signer);
  if (allowed.isErr()) {
    return err(allowed.error);
  }
  if (!allowed.value) {
    return rejectQuoteRequest(env, quoted.value, signer, request);
  }
  const quoting = await cacheInstrument(delivery, instrument);
  if (quoting.isErr()) {
    return err(quoting.error);
  }
  const quote = await quoteOf(env.DB, quoting.value, quoted.value.note);
  if (quote.isErr()) {
    return err(quote.error);
  }
  // Mastodon's sanity check: the note the signer sent does quote this one.
  if (!quoting.value || !quote.value) {
    return ok(undefined);
  }
  const taken = await requestIdTaken(env.DB, activity.id, quote.value);
  if (taken.isErr() || taken.value) {
    return taken.map(() => undefined);
  }
  const requested = { ...quote.value, activityUri: activity.id };
  const accepted =
    requested.state.kind === "Accepted"
      ? ok(requested)
      : Quote.accept(requested, { kind: "Implicit" });
  if (accepted.isErr()) {
    return rejectQuoteRequest(env, quoted.value, signer, request);
  }
  const saved = await saveQuoteState(env.DB, accepted.value);
  if (saved.isErr()) {
    return err(saved.error);
  }
  await sendAnswer(
    env,
    quoted.value.author,
    signer,
    "Accept",
    quoteRequestAnswerActivity(
      { kind: "Accept", stamp: quoteAuthorizationUri(quotedRef.authorUri, accepted.value.id) },
      quotedRef.authorUri,
      accepted.value.id,
      { ...request, instrument: quoting.value.objectUri },
    ),
  );
  if (quote.value.state.kind === "Accepted") {
    return ok(undefined);
  }
  await announceRemoteQuoteChange(env, quoting.value);
  const access = await ensureQuotedAccess(
    env,
    delivery.identity,
    quoting.value,
    quoted.value.author.id,
  );
  if (access.isErr()) {
    return err(access.error);
  }
  if (!(await canViewRemoteStatus(env.DB, quoting.value, quoted.value.author.id))) {
    return ok(undefined);
  }
  return notifyFromRemote(env, {
    accountId: quoted.value.author.id,
    actorUri: signer.actorUri,
    kind: "quote",
    statusId: quoting.value.id,
  });
};
