import {
  Hostname,
  type InstanceIdentity,
  type OutboxJob,
  Quote,
  QuoteRetry,
  type QuoteValue,
  RemoteActor,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountById } from "./account-store";
import { suspendedDomains } from "./admin-domain-block-store";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import type { FederatedFetchOptions } from "./federated-fetch";
import { announceNoteUpdate } from "./local-status-update";
import { findQuoteById, saveQuoteState } from "./quote-store";
import { enqueueQuoteRefetch } from "./quote-retry-queue";
import { reverifyRemoteQuote } from "./remote-quote";
import { announceRemoteQuoteChange } from "./remote-quote-announce";
import { fetchStamp } from "./remote-quote-verify";
import { findRemoteActorByUri } from "./remote-actor-store";
import { remoteQuoteContext } from "./remote-status-persist";
import { findRemoteStatusById } from "./remote-status-store";
import { allowListAdmits, federationAllowHosts, parseInstanceIdentity } from "./runtime-config";
import { findStatusById } from "./status-store";

type RefetchAndVerifyQuote = Extract<OutboxJob, { kind: "RefetchAndVerifyQuote" }>;
type RefreshQuote = Extract<OutboxJob, { kind: "RefreshQuote" }>;

/** The federation guards: suspended domains and the allow list. */
const federationOptions = async (env: Env): Promise<FederatedFetchOptions> => ({
  allowHosts: await federationAllowHosts(env),
  blockedHosts: await suspendedDomains(env.DB),
});

/** Whether `uri` sits on a host this instance federates with. */
const federatesWith = (options: FederatedFetchOptions, uri: string): boolean => {
  const host = Hostname.ofUri(uri);
  return (
    host !== undefined &&
    !(options.blockedHosts?.has(host) ?? false) &&
    allowListAdmits(options.allowHosts ?? new Set(), host)
  );
};

/** Whether the quote still names the quoted note the job was queued for. */
const namesQuoted = async (
  db: D1Database,
  quote: QuoteValue,
  quotedUri: string,
): Promise<Result<boolean, RepositoryError>> => {
  switch (quote.quoted.kind) {
    case "Unresolved":
      return ok(quote.quoted.uri === quotedUri);
    case "LocalStatus":
      return ok(false);
    case "RemoteStatus":
      return (await findRemoteStatusById(db, quote.quoted.statusId)).map(
        (quoted) => quoted?.objectUri === quotedUri,
      );
  }
};

/**
 * Check a pending quote by a remote note again, as Mastodon's
 * `RefetchAndVerifyQuoteWorker`. The job is dropped when the quote is gone,
 * no longer pending (accepted, rejected or revoked meanwhile, as by the
 * note's `Update`), names another quoted note, or its author is gone,
 * suspended or outside the allow list. A quote that changed is announced on
 * the local timelines showing the note; one still left to check again is
 * queued for the next attempt until {@link QuoteRetry.refetchMaxAttempts}.
 */
export const processRefetchAndVerifyQuoteJob = async (
  env: Env,
  job: RefetchAndVerifyQuote,
): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  const quote = await findQuoteById(env.DB, job.quoteId);
  if (identity.isErr() || quote.isErr()) {
    return "retry";
  }
  if (quote.value?.state.kind !== "Pending" || quote.value.quoting.kind !== "RemoteStatus") {
    return "ok";
  }
  const named = await namesQuoted(env.DB, quote.value, job.quotedUri);
  const status = await findRemoteStatusById(env.DB, quote.value.quoting.statusId);
  if (named.isErr() || status.isErr()) {
    return "retry";
  }
  if (!named.value || !status.value) {
    return "ok";
  }
  const actor = await findRemoteActorByUri(env.DB, status.value.actorUri);
  if (actor.isErr()) {
    return "retry";
  }
  const options = await federationOptions(env);
  if (
    !actor.value ||
    RemoteActor.onAnyHost(actor.value, options.blockedHosts ?? new Set()) ||
    !federatesWith(options, actor.value.actorUri)
  ) {
    return "ok";
  }
  const synced = await reverifyRemoteQuote(
    env,
    identity.value,
    status.value,
    quote.value,
    { quotedUri: job.quotedUri, approvalUri: job.approvalUri },
    remoteQuoteContext(env, identity.value, actor.value, options),
  );
  if (synced.isErr()) {
    return "retry";
  }
  if (synced.value.changed) {
    await announceRemoteQuoteChange(env, status.value);
  }
  const next = QuoteRetry.nextRefetchAttempt(job.attempt);
  if (synced.value.refetch && next !== undefined) {
    await enqueueQuoteRefetch(env, synced.value.refetch, next);
  }
  return "ok";
};

/**
 * How to announce a change of a quote, when its quoting status is still
 * there: a local note on its author's streams and timelines, a remote one
 * on the local timelines showing it.
 */
type Announce = () => Promise<void>;

const quoteAnnouncer = async (
  env: Env,
  identity: InstanceIdentity,
  quote: QuoteValue,
): Promise<Result<Announce | undefined, RepositoryError>> => {
  if (quote.quoting.kind === "RemoteStatus") {
    return (await findRemoteStatusById(env.DB, quote.quoting.statusId)).map(
      (status) => status && (() => announceRemoteQuoteChange(env, status)),
    );
  }
  const note = await findStatusById(env.DB, quote.quoting.statusId);
  if (note.isErr()) {
    return err(note.error);
  }
  if (note.value?.kind !== "LocalNote") {
    return ok(undefined);
  }
  const local = note.value;
  const author = await findAccountById(env.DB, local.accountId);
  if (author.isErr()) {
    return err(author.error);
  }
  const account = author.value;
  return ok(
    account &&
      (async () => {
        const announced = await announceNoteUpdate(env, identity, account, local, nowIso(), false);
        if (announced.isErr()) {
          console.error(JSON.stringify({ kind: "QuoteRefreshNotAnnounced", quoteId: quote.id }));
        }
      }),
  );
};

/**
 * Fetch the stamp of an accepted quote of a remote status again, as
 * Mastodon's `QuoteRefreshWorker` runs `VerifyQuoteService`: a stamp that no
 * longer resolves (4xx) revokes the quote (`Quote#reject!`), which is
 * announced as a change. A stamp that still resolves, a temporary failure,
 * and a quote no longer accepted on a stamp change nothing; the view that
 * queued the job already marked the quote checked, so a failure waits for
 * the next interval, as Mastodon's worker skips a quote it touched. A stamp
 * on a suspended host or outside the allow list is not fetched.
 */
export const processRefreshQuoteJob = async (
  env: Env,
  job: RefreshQuote,
): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  const quote = await findQuoteById(env.DB, job.quoteId);
  if (identity.isErr() || quote.isErr()) {
    return "retry";
  }
  const state = quote.value?.state;
  if (
    quote.value === undefined ||
    state?.kind !== "Accepted" ||
    state.approval.kind !== "Stamp" ||
    quote.value.quoted.kind !== "RemoteStatus"
  ) {
    return "ok";
  }
  const stampUri = state.approval.uri;
  const options = await federationOptions(env);
  if (!federatesWith(options, stampUri)) {
    return "ok";
  }
  const announce = await quoteAnnouncer(env, identity.value, quote.value);
  if (announce.isErr()) {
    return "retry";
  }
  if (!announce.value) {
    return "ok";
  }
  const stamp = await fetchStamp(identity.value, stampUri, options);
  if (stamp.kind !== "Gone") {
    return "ok";
  }
  const saved = await saveQuoteState(env.DB, Quote.reject(quote.value));
  if (saved.isErr()) {
    return "retry";
  }
  await announce.value();
  return "ok";
};
