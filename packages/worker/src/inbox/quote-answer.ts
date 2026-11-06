import {
  type InstanceIdentity,
  type LocalAccount,
  type LocalNote,
  Quote,
  type QuoteValue,
  type RemoteActor,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountById } from "../account-store";
import { localNoteRef } from "../activitypub";
import { refId } from "../activitypub-wire";
import { nowIso } from "../clock";
import type { RepositoryError } from "../d1";
import { announceNoteUpdate } from "../local-status-update";
import { findQuoteByApprovalUri, saveQuoteState } from "../quote-store";
import { stampAuthorizes } from "../remote-quote-verify";
import { findRemoteStatusById } from "../remote-status-store";
import { findStatusById } from "../status-store";
import type { RemoteDelivery } from "./handler";

/** A local note quoting a status of the signer, as the quote's two ends. */
type SignerQuote = Readonly<{
  note: LocalNote;
  author: LocalAccount;
  quotingUri: string;
  quotedUri: string;
}>;

/**
 * The local note and the signer's quoted status of `quote`, when the quote
 * is one the signer may answer: a local note quoting the signer's status.
 */
const signerQuote = async (
  db: D1Database,
  identity: InstanceIdentity,
  quote: QuoteValue,
  signer: RemoteActor,
): Promise<Result<SignerQuote | undefined, RepositoryError>> => {
  if (quote.quoting.kind !== "LocalStatus" || quote.quoted.kind !== "RemoteStatus") {
    return ok(undefined);
  }
  const quoted = await findRemoteStatusById(db, quote.quoted.statusId);
  if (quoted.isErr()) {
    return err(quoted.error);
  }
  if (quoted.value?.actorUri !== signer.actorUri) {
    return ok(undefined);
  }
  const note = await findStatusById(db, quote.quoting.statusId);
  if (note.isErr()) {
    return err(note.error);
  }
  if (note.value?.kind !== "LocalNote") {
    return ok(undefined);
  }
  const author = await findAccountById(db, note.value.accountId);
  if (author.isErr()) {
    return err(author.error);
  }
  return ok(
    author.value && {
      note: note.value,
      author: author.value,
      quotingUri: localNoteRef(identity, author.value, note.value.id).uri,
      quotedUri: quoted.value.objectUri,
    },
  );
};

/**
 * Store the quote's new state and tell the quoting author's streams and
 * timelines, as Mastodon's `DistributionWorker`; `federate` also sends the
 * note's `Update`, which then carries the stamp.
 */
const settle = async (
  env: Env,
  identity: InstanceIdentity,
  quoting: SignerQuote,
  quote: QuoteValue,
  federate: boolean,
): Promise<Result<void, RepositoryError>> => {
  const saved = await saveQuoteState(env.DB, quote);
  if (saved.isErr()) {
    return err(saved.error);
  }
  const announced = await announceNoteUpdate(
    env,
    identity,
    quoting.author,
    quoting.note,
    nowIso(),
    federate,
  );
  if (announced.isErr()) {
    console.error(JSON.stringify({ kind: "QuoteAnswerNotAnnounced", quoteId: quote.id }));
  }
  return ok(undefined);
};

const httpsHost = (uri: string): string | undefined => {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" ? url.host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The stamp an `Accept` names in `result`, when it can be the signer's stamp
 * for this quote: an https URI on the signer's host, as Mastodon's
 * `accept_quote!` checks. An inline stamp must also name this quote's two
 * ends and the signer. The stamp is not fetched: as Mastodon says, the
 * `Accept` is as authoritative as the stamp.
 */
const acceptedStamp = (
  result: unknown,
  signer: RemoteActor,
  quoting: SignerQuote,
): string | undefined => {
  const first: unknown = Array.isArray(result) ? result[0] : result;
  const uri = refId(first);
  const signerHost = httpsHost(signer.actorUri);
  if (uri === undefined || signerHost === undefined || httpsHost(uri) !== signerHost) {
    return undefined;
  }
  if (typeof first === "string") {
    return uri;
  }
  return stampAuthorizes(first, {
    uri,
    quotingUri: quoting.quotingUri,
    quotedUri: quoting.quotedUri,
    quotedActorUri: signer.actorUri,
  })
    ? uri
    : undefined;
};

/**
 * The quoted author answers a local author's `QuoteRequest`, as Mastodon's
 * `accept_quote!` and `reject_quote!`. An `Accept` of a pending quote stores
 * the stamp and federates the note again with `quoteAuthorization`. A
 * `Reject` rejects the quote, or revokes an accepted one, and federates
 * nothing, as Mastodon.
 */
export const receiveQuoteAnswer = async (
  { env, identity, signer, activity, received }: RemoteDelivery<"Accept" | "Reject">,
  quote: QuoteValue,
): Promise<Result<void, RepositoryError>> => {
  const quoting = await signerQuote(env.DB, identity, quote, signer);
  if (quoting.isErr() || quoting.value === undefined) {
    return quoting.map(() => undefined);
  }
  if (activity.kind === "Reject") {
    return settle(env, identity, quoting.value, Quote.reject(quote), false);
  }
  const stamp = acceptedStamp(received.result, signer, quoting.value);
  const accepted =
    stamp === undefined ? undefined : Quote.accept(quote, { kind: "Stamp", uri: stamp });
  return accepted?.isOk()
    ? settle(env, identity, quoting.value, accepted.value, true)
    : ok(undefined);
};

/**
 * The quoted author deleted the stamp of a quote, as Mastodon's
 * `Delete#revoke_quote`: the quote is revoked. `false` when `uri` is no
 * stamp the signer gave, so the `Delete` is for something else.
 */
export const revokeQuoteStamp = async (
  env: Env,
  identity: InstanceIdentity,
  signer: RemoteActor,
  uri: string,
): Promise<Result<boolean, RepositoryError>> => {
  const quote = await findQuoteByApprovalUri(env.DB, uri);
  if (quote.isErr()) {
    return err(quote.error);
  }
  if (
    !quote.value ||
    (quote.value.state.kind !== "Pending" && quote.value.state.kind !== "Accepted")
  ) {
    return ok(false);
  }
  const quoting = await signerQuote(env.DB, identity, quote.value, signer);
  if (quoting.isErr()) {
    return err(quoting.error);
  }
  if (!quoting.value) {
    return ok(false);
  }
  return (await settle(env, identity, quoting.value, Quote.reject(quote.value), false)).map(
    () => true,
  );
};
