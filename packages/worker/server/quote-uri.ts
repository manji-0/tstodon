import {
  type InstanceIdentity,
  type QuoteState,
  type StatusIdValue,
  StatusTarget,
  type StatusTargetValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { type ActivityObjectRef, localNoteRef, type NoteQuote } from "./activitypub";
import { findAccountById } from "./account-store";
import type { RepositoryError } from "./d1";
import { quoteAuthorizationUri } from "./quote-authorization-document";
import { findQuoteByQuoting } from "./quote-store";
import { findRemoteStatusById } from "./remote-status-store";
import { findStatusById } from "./status-store";

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
  if (!quote.value) {
    return ok(undefined);
  }
  const { id, state, quoted } = quote.value;
  if (
    state.kind !== "Pending" &&
    state.kind !== "Accepted" &&
    state.kind !== "Rejected" &&
    state.kind !== "Revoked"
  ) {
    return ok(undefined);
  }
  // A local note's quoted status is always resolved; only remote notes name unresolved ones.
  if (quoted.kind === "Unresolved") {
    return ok(undefined);
  }
  const found = await statusTargetRef(env, identity, quoted);
  return found.map((ref) =>
    ref === undefined
      ? undefined
      : {
          uri: ref.uri,
          authorization:
            state.kind === "Accepted" ? approvalUri(state, quoted, ref, id) : undefined,
          addressAuthor: quoted.kind === "RemoteStatus" ? ref.authorUri : undefined,
        },
  );
};
