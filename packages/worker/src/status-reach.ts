import type {
  FindRemoteActorInbox,
  FindThreadParent,
  ListLocalBoosterAccountIds,
  ListRemoteFollowerInboxes,
  ListStatusInteractorInboxes,
  RemoteActor,
  ThreadStatus,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";

/** Mastodon's `Status#distributable?`: public or unlisted. */
const distributable = (status: ThreadStatus): boolean =>
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
 * unlisted status, and, for a local status that is not direct, its author's
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
  if (status.kind === "Local" && status.status.visibility.kind !== "Direct") {
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

export type StampDeleteForwardOperations = Readonly<{
  listLocalBoosterAccountIds: ListLocalBoosterAccountIds;
  listRemoteFollowerInboxes: ListRemoteFollowerInboxes;
  findThreadParent: FindThreadParent;
}>;

/** A forward of an inbound activity: the local account whose key signs it, and the inboxes. */
export type InboundForward = Readonly<{
  signerAccountId: string;
  inboxes: ReadonlyArray<string>;
}>;

/**
 * Where an inbound stamp `Delete` is forwarded, as Mastodon's
 * `ActivityPub::Forwarder` for the quoting status: only a public or unlisted
 * one; to the remote followers of the local accounts that boosted it and,
 * when it replies to a local status, of that status's author, without the
 * sender's own inboxes. The replied-to local author signs, else the first
 * local booster; with neither there is nothing to forward.
 */
export const stampDeleteForward = async (
  operations: StampDeleteForwardOperations,
  quoting: ThreadStatus,
  sender: Pick<RemoteActor, "inboxUri" | "sharedInboxUri">,
): Promise<Result<InboundForward | undefined, RepositoryError>> => {
  if (!distributable(quoting)) {
    return ok(undefined);
  }
  const boosters = await operations.listLocalBoosterAccountIds(quoting);
  if (boosters.isErr()) {
    return err(boosters.error);
  }
  const parent = await operations.findThreadParent(quoting);
  if (parent.isErr()) {
    return err(parent.error);
  }
  const repliedTo = parent.value?.kind === "Local" ? parent.value.status.accountId : undefined;
  const signerAccountId = repliedTo ?? boosters.value[0];
  if (signerAccountId === undefined) {
    return ok(undefined);
  }
  const followers = await followerInboxes(operations.listRemoteFollowerInboxes, [
    ...boosters.value,
    ...(repliedTo === undefined ? [] : [repliedTo]),
  ]);
  if (followers.isErr()) {
    return err(followers.error);
  }
  const own = new Set([sender.inboxUri, sender.sharedInboxUri]);
  const inboxes = [...new Set(followers.value)].filter((inbox) => !own.has(inbox));
  return ok(inboxes.length === 0 ? undefined : { signerAccountId, inboxes });
};
