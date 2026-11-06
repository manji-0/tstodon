import {
  type InstanceIdentity,
  type QuoteState,
  type StatusIdValue,
  StatusTarget,
  type StatusTargetValue,
} from "@tstodon/domain";
import { type ActivityObjectRef, localNoteRef, type NoteQuote } from "./activitypub";
import { findAccountById } from "./account-store";
import { quoteAuthorizationUri } from "./quote-authorization-document";
import { findQuoteByQuoting } from "./quote-store";
import { findRemoteStatusById } from "./remote-status-store";
import { findStatusById } from "./status-store";

/** A status's ActivityPub URI and its author's, while both still exist. */
export const statusTargetRef = async (
  env: Env,
  identity: InstanceIdentity,
  target: StatusTargetValue,
): Promise<ActivityObjectRef | undefined> => {
  if (target.kind === "RemoteStatus") {
    const remote = await findRemoteStatusById(env.DB, target.statusId);
    return remote.isOk() && remote.value
      ? { uri: remote.value.objectUri, authorUri: remote.value.actorUri }
      : undefined;
  }
  const status = await findStatusById(env.DB, target.statusId);
  if (status.isErr() || !status.value) {
    return undefined;
  }
  const author = await findAccountById(env.DB, status.value.accountId);
  if (author.isErr() || !author.value) {
    return undefined;
  }
  return localNoteRef(identity, author.value, status.value.id);
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
 * properties. A pending or accepted quote names it; an absent, rejected,
 * revoked, or dangling one does not.
 */
export const noteQuote = async (
  env: Env,
  identity: InstanceIdentity,
  statusId: StatusIdValue,
): Promise<NoteQuote | undefined> => {
  const quote = await findQuoteByQuoting(env.DB, StatusTarget.local(statusId));
  if (quote.isErr() || !quote.value) {
    return undefined;
  }
  const { id, state, quoted } = quote.value;
  if (state.kind !== "Pending" && state.kind !== "Accepted") {
    return undefined;
  }
  const ref = await statusTargetRef(env, identity, quoted);
  return ref === undefined
    ? undefined
    : {
        uri: ref.uri,
        authorization: approvalUri(state, quoted, ref, id),
        addressAuthor: quoted.kind === "RemoteStatus" ? ref.authorUri : undefined,
      };
};
