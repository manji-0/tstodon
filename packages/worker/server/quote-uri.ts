import {
  type InstanceIdentity,
  type QuoteState,
  type QuoteValue,
  type StatusIdValue,
  StatusTarget,
  type StatusTargetValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { type ActivityObjectRef, localNoteRef, type NoteQuote } from "./activitypub";
import { findAccountById, findAccountsByIds } from "./account-store";
import type { RepositoryError } from "./d1";
import { quoteAuthorizationUri } from "./quote-authorization-document";
import { findQuoteByQuoting, findQuotesByQuoting } from "./quote-store";
import { findRemoteStatusById, findRemoteStatusesByIds } from "./remote-status-store";
import { findStatusById, findStatusesByIds } from "./status-store";

/**
 * A status's ActivityPub URI and its author's, or `undefined` once either is
 * gone; an error when they could not be read.
 */
export const statusTargetRef = async (
  env: Env,
  identity: InstanceIdentity,
  target: StatusTargetValue,
): Promise<Result<ActivityObjectRef | undefined, RepositoryError>> => {
  if (target.kind === "RemoteStatus") {
    const remote = await findRemoteStatusById(env.DB, target.statusId);
    return remote.map((found) =>
      found ? { uri: found.objectUri, authorUri: found.actorUri } : undefined,
    );
  }
  const status = await findStatusById(env.DB, target.statusId);
  if (status.isErr()) {
    return err(status.error);
  }
  if (!status.value) {
    return ok(undefined);
  }
  const { id, accountId } = status.value;
  const author = await findAccountById(env.DB, accountId);
  return author.map((found) => (found ? localNoteRef(identity, found, id) : undefined));
};

/**
 * {@link statusTargetRef} for several statuses, in three statements, keyed by
 * status id (local and remote statuses share one id space). A status that is
 * gone, or whose author is, has no entry.
 */
export const statusTargetRefs = async (
  env: Env,
  identity: InstanceIdentity,
  targets: ReadonlyArray<StatusTargetValue>,
): Promise<Result<ReadonlyMap<string, ActivityObjectRef>, RepositoryError>> => {
  const idsOf = (kind: StatusTargetValue["kind"]) =>
    targets.flatMap((target) => (target.kind === kind ? [target.statusId] : []));
  const [remotes, locals] = await Promise.all([
    findRemoteStatusesByIds(env.DB, idsOf("RemoteStatus")),
    findStatusesByIds(env.DB, idsOf("LocalStatus")),
  ]);
  if (remotes.isErr()) {
    return err(remotes.error);
  }
  if (locals.isErr()) {
    return err(locals.error);
  }
  const authors = await findAccountsByIds(
    env.DB,
    [...locals.value.values()].map((status) => status.accountId),
  );
  if (authors.isErr()) {
    return err(authors.error);
  }
  return ok(
    new Map([
      ...[...remotes.value.values()].map((found): [string, ActivityObjectRef] => [
        found.id,
        { uri: found.objectUri, authorUri: found.actorUri },
      ]),
      ...[...locals.value.values()].flatMap((status): [string, ActivityObjectRef][] => {
        const author = authors.value.get(status.accountId);
        return author ? [[status.id, localNoteRef(identity, author, status.id)]] : [];
      }),
    ]),
  );
};

/**
 * The stamp an accepted quote carries, as Mastodon's `approval_uri_for`: the
 * remote quoted author's, or one this server mints for a local quoted status.
 */
const approvalUri = (
  state: QuoteState,
  quoted: StatusTargetValue,
  quotedRef: ActivityObjectRef,
  quoteId: string,
): string | undefined => {
  if (state.kind !== "Accepted") {
    return undefined;
  }
  if (state.approval.kind === "Stamp") {
    return state.approval.uri;
  }
  return quoted.kind === "LocalStatus"
    ? quoteAuthorizationUri(quotedRef.authorUri, quoteId)
    : undefined;
};

/** The resolved status `quote` names, when its state lets a note name it. */
const namedStatus = (quote: QuoteValue): StatusTargetValue | undefined => {
  const { state, quoted } = quote;
  if (
    state.kind !== "Pending" &&
    state.kind !== "Accepted" &&
    state.kind !== "Rejected" &&
    state.kind !== "Revoked"
  ) {
    return undefined;
  }
  // A local note's quoted status is always resolved; only remote notes name unresolved ones.
  return quoted.kind === "Unresolved" ? undefined : quoted;
};

const quoteOf = (
  quote: QuoteValue,
  quoted: StatusTargetValue,
  ref: ActivityObjectRef,
): NoteQuote => ({
  uri: ref.uri,
  authorization:
    quote.state.kind === "Accepted" ? approvalUri(quote.state, quoted, ref, quote.id) : undefined,
  addressAuthor: quoted.kind === "RemoteStatus" ? ref.authorUri : undefined,
});

/**
 * The status a local note quotes, for its `quote` and `quoteAuthorization`
 * properties. A pending, accepted, rejected, or revoked quote names it, as
 * Mastodon's `NoteSerializer` keeps `quote` after a refusal; only an accepted
 * quote carries `quoteAuthorization`. An absent, deleted, or dangling one
 * does not. An error when the quote or its status could not be read.
 */
export const noteQuote = async (
  env: Env,
  identity: InstanceIdentity,
  statusId: StatusIdValue,
): Promise<Result<NoteQuote | undefined, RepositoryError>> => {
  const quote = await findQuoteByQuoting(env.DB, StatusTarget.local(statusId));
  if (quote.isErr()) {
    return err(quote.error);
  }
  const quoted = quote.value ? namedStatus(quote.value) : undefined;
  if (!quote.value || !quoted) {
    return ok(undefined);
  }
  const { value } = quote;
  const found = await statusTargetRef(env, identity, quoted);
  return found.map((ref) => (ref === undefined ? undefined : quoteOf(value, quoted, ref)));
};

/** {@link noteQuote} for several local notes, keyed by note id; a note that names no quote has no entry. */
export const noteQuotes = async (
  env: Env,
  identity: InstanceIdentity,
  statusIds: ReadonlyArray<StatusIdValue>,
): Promise<Result<ReadonlyMap<string, NoteQuote>, RepositoryError>> => {
  const quotes = await findQuotesByQuoting(env.DB, statusIds.map(StatusTarget.local));
  if (quotes.isErr()) {
    return err(quotes.error);
  }
  const named = [...quotes.value].flatMap(
    ([statusId, quote]): [string, QuoteValue, StatusTargetValue][] => {
      const quoted = namedStatus(quote);
      return quoted ? [[statusId, quote, quoted]] : [];
    },
  );
  const refs = await statusTargetRefs(
    env,
    identity,
    named.map(([, , quoted]) => quoted),
  );
  return refs.map(
    (found) =>
      new Map(
        named.flatMap(([statusId, quote, quoted]): [string, NoteQuote][] => {
          const ref = found.get(quoted.statusId);
          return ref ? [[statusId, quoteOf(quote, quoted, ref)]] : [];
        }),
      ),
  );
};
