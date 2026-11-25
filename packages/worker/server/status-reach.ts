import type {
  FindRemoteActorInbox,
  FindThreadParent,
  ListLocalBoosterFollowerInboxes,
  ListLocalSharerAccountIds,
  ListRemoteFollowerInboxes,
  ListStatusInteractorInboxes,
  ThreadStatus,
} from "@tstodon/domain";
import { Visibility } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";

/** Mastodon's `Status#distributable?`: public or unlisted. */
export const distributable = (status: ThreadStatus): boolean =>
  status.status.visibility.kind === "Public" || status.status.visibility.kind === "Unlisted";

const followerInboxes = async (
  list: ListRemoteFollowerInboxes,
  accountIds: Iterable<string>,
): Promise<Result<string[], RepositoryError>> => {
  const inboxes: string[] = [];
  for (const accountId of new Set(accountIds)) {
    const found = await list(accountId);
    if (found.isErr()) {
      return err(found.error);
    }
    inboxes.push(...found.value);
  }
  return ok(inboxes);
};

export type StatusReachOperations = Readonly<{
  listInteractorInboxes: ListStatusInteractorInboxes;
  listRemoteFollowerInboxes: ListRemoteFollowerInboxes;
  findRemoteActorInbox: FindRemoteActorInbox;
  findThreadParent: FindThreadParent;
}>;

/**
 * The remote inboxes a status reached, as Mastodon's `StatusReachFinder`
 * with `unsafe: true`: the actors that interacted with it
 * (`listInteractorInboxes`), the replied-to remote author of a public or
 * unlisted status, and, for a local status that is not direct or limited, its author's
 * remote followers, with those of a local replied-to author when the status
 * is public or unlisted. A remote author's own followers are not known here.
 */
export const statusReachInboxes = async (
  operations: StatusReachOperations,
  status: ThreadStatus,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> => {
  const interactors = await operations.listInteractorInboxes(status);
  if (interactors.isErr()) {
    return err(interactors.error);
  }
  const parent = await operations.findThreadParent(status);
  if (parent.isErr()) {
    return err(parent.error);
  }
  const inboxes = [...interactors.value];
  if (parent.value?.kind === "Remote" && distributable(status)) {
    const repliedTo = await operations.findRemoteActorInbox(parent.value.status.actorUri);
    if (repliedTo.isErr()) {
      return err(repliedTo.error);
    }
    inboxes.push(...(repliedTo.value === undefined ? [] : [repliedTo.value]));
  }
  if (status.kind === "Local" && !Visibility.requiresMention(status.status.visibility)) {
    const authors = [
      status.status.accountId,
      ...(parent.value?.kind === "Local" && distributable(status)
        ? [parent.value.status.accountId]
        : []),
    ];
    const followers = await followerInboxes(operations.listRemoteFollowerInboxes, authors);
    if (followers.isErr()) {
      return err(followers.error);
    }
    inboxes.push(...followers.value);
  }
  return ok([...new Set(inboxes)]);
};

export type StatusDeleteReachOperations = StatusReachOperations &
  Readonly<{
    listLocalBoosterFollowerInboxes: ListLocalBoosterFollowerInboxes;
  }>;

/**
 * Where the `Delete` of a local status goes: its reach
 * ({@link statusReachInboxes}, Mastodon's `RemoveStatusService#remove_from_remote_reach`)
 * and, for a public or unlisted status, the remote followers of the local
 * accounts that boosted it. Mastodon forwards the `Delete` of a remote status
 * to those followers (`ActivityPub::Forwarder`) but sends nothing to them for
 * a local one, so they keep the boost; tstodon sends the author's `Delete`.
 * Read before the boosts and interactions are deleted with the status.
 */
export const statusDeleteReach = async (
  operations: StatusDeleteReachOperations,
  status: ThreadStatus,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> => {
  const reach = await statusReachInboxes(operations, status);
  if (reach.isErr() || !distributable(status)) {
    return reach;
  }
  const followers = await operations.listLocalBoosterFollowerInboxes(status);
  if (followers.isErr()) {
    return err(followers.error);
  }
  return ok([...new Set([...reach.value, ...followers.value])]);
};

/**
 * Where the `Delete` of a quote's stamp goes, as Mastodon's
 * `RevokeQuoteService`: the reach of the quoting and the quoted status. A
 * remote quoting author's inbox is added, which Mastodon's reach leaves out
 * unless that author interacted, so the quoting server always hears it.
 */
export const quoteStampReach = async (
  operations: StatusReachOperations,
  quoted: ThreadStatus,
  quoting: ThreadStatus,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> => {
  const inboxes: string[] = [];
  for (const status of [quoting, quoted]) {
    const reach = await statusReachInboxes(operations, status);
    if (reach.isErr()) {
      return err(reach.error);
    }
    inboxes.push(...reach.value);
  }
  if (quoting.kind === "Remote") {
    const author = await operations.findRemoteActorInbox(quoting.status.actorUri);
    if (author.isErr()) {
      return err(author.error);
    }
    inboxes.push(...(author.value === undefined ? [] : [author.value]));
  }
  return ok([...new Set(inboxes)]);
};

export type RemoteActivityForwardOperations = Readonly<{
  listLocalSharerAccountIds: ListLocalSharerAccountIds;
  findThreadParent: FindThreadParent;
}>;

/**
 * A forward of an inbound activity before its audience is read: the local
 * account whose key signs the requests, and the local author the status
 * replies to, whose followers receive it with the sharers'.
 */
export type PlannedForward = Readonly<{
  signerAccountId: string;
  repliedToAccountId: string | undefined;
}>;

/**
 * Who signs an activity about `status` that another server signed, as
 * Mastodon's `ActivityPub::Forwarder` (and `forward_for_reply`, the same
 * rule for a new reply, which nobody shared yet): the replied-to local
 * author, else the first local account that boosted or quoted it; with
 * neither there is nothing to forward. The followers of all of them hear it
 * (`ForwardAudience`). Whether the activity may be forwarded at all
 * (`Forwarder#forwardable?`) is the caller's to ask.
 */
export const remoteActivityForward = async (
  operations: RemoteActivityForwardOperations,
  status: ThreadStatus,
): Promise<Result<PlannedForward | undefined, RepositoryError>> => {
  const sharers = await operations.listLocalSharerAccountIds(status, 1);
  if (sharers.isErr()) {
    return err(sharers.error);
  }
  const parent = await operations.findThreadParent(status);
  if (parent.isErr()) {
    return err(parent.error);
  }
  const repliedTo = parent.value?.kind === "Local" ? parent.value.status.accountId : undefined;
  const signerAccountId = repliedTo ?? sharers.value[0];
  if (signerAccountId === undefined) {
    return ok(undefined);
  }
  return ok({ signerAccountId, repliedToAccountId: repliedTo });
};
