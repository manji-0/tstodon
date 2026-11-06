import {
  InstanceIdentity,
  type StatusIdValue,
  StatusTarget,
  type StatusTargetValue,
} from "@tstodon/domain";
import type { NoteQuote } from "./activitypub";
import { findAccountById } from "./account-store";
import { findQuoteByQuoting } from "./quote-store";
import { findRemoteStatusById } from "./remote-status-store";
import { findStatusById } from "./status-store";

/** The ActivityPub URI of a quoted status that still exists. */
const quotedUri = async (
  env: Env,
  identity: InstanceIdentity,
  quoted: StatusTargetValue,
): Promise<string | undefined> => {
  if (quoted.kind === "RemoteStatus") {
    const remote = await findRemoteStatusById(env.DB, quoted.statusId);
    return remote.isOk() ? remote.value?.objectUri : undefined;
  }
  const target = await findStatusById(env.DB, quoted.statusId);
  if (target.isErr() || !target.value) {
    return undefined;
  }
  const author = await findAccountById(env.DB, target.value.accountId);
  if (author.isErr() || !author.value) {
    return undefined;
  }
  return `${InstanceIdentity.actorUrl(identity, author.value.username)}/statuses/${target.value.id}`;
};

/**
 * The status a local note quotes, for its `quote` property. A pending or
 * accepted quote names it; an absent, rejected, revoked, or dangling one does
 * not.
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
  const { state, quoted } = quote.value;
  if (state.kind !== "Pending" && state.kind !== "Accepted") {
    return undefined;
  }
  const uri = await quotedUri(env, identity, quoted);
  return uri === undefined ? undefined : { uri };
};
