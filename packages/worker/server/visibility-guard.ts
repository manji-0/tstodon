import {
  OutboundFollow,
  Visibility,
  type LocalStatus,
  type RemoteBoostValue as RemoteBoost,
  type RemoteStatus,
} from "@tstodon/domain";
import { findBlock } from "./block-mute-store";
import { findRemoteStatusById } from "./remote-status-store";
import { isAccountMentionedOnStatus } from "./mention-store";
import { isAccountMentionedOnRemoteStatus } from "./mention-store";
import { findOutboundFollow } from "./outbound-follow-store";
import { relationshipFlags } from "./relationship-store";
import { findRemoteBlock } from "./remote-block-store";
import { findStatusById } from "./status-store";

const canViewDirectStatus = async (
  db: D1Database,
  status: Extract<LocalStatus, { kind: "LocalNote" }>,
  viewerId: string,
): Promise<boolean> => {
  if (viewerId === status.accountId) {
    return true;
  }
  const mentioned = await isAccountMentionedOnStatus(db, status.id, viewerId);
  if (mentioned.isOk() && mentioned.value) {
    return true;
  }
  if (!status.inReplyToId) {
    return false;
  }
  const parent = await findStatusById(db, status.inReplyToId);
  if (parent.isErr() || !parent.value || parent.value.kind !== "LocalNote") {
    return false;
  }
  if (parent.value.visibility.kind !== "Direct") {
    return false;
  }
  return canViewDirectStatus(db, parent.value, viewerId);
};

/**
 * Mastodon's `StatusPolicy#show?` for a status that is not direct: a public or
 * unlisted one is hidden only from viewers its author blocks; a followers-only
 * one is shown to the author, followers and the accounts it mentions. Viewers
 * are local accounts, so the policy's domain-block clause never applies.
 */
const canViewNonDirect = async (
  db: D1Database,
  status: LocalStatus,
  viewerId: string | undefined,
): Promise<boolean> => {
  if (viewerId === status.accountId) {
    return true;
  }
  if (!viewerId) {
    return !Visibility.isRestricted(status.visibility);
  }
  if (!Visibility.isRestricted(status.visibility)) {
    const blocked = await findBlock(db, status.accountId, viewerId);
    return blocked.isOk() && !blocked.value;
  }
  const flags = await relationshipFlags(db, viewerId, status.accountId);
  if (flags.isOk() && flags.value.following) {
    return true;
  }
  const mentioned = await isAccountMentionedOnStatus(db, status.id, viewerId);
  return mentioned.isOk() && mentioned.value;
};

export const canViewStatus = async (
  db: D1Database,
  status: LocalStatus,
  viewerId: string | undefined,
): Promise<boolean> => {
  // A boost's own visibility decides who sees it, and it is never direct.
  if (status.kind === "LocalNote" && status.visibility.kind === "Direct") {
    return viewerId ? canViewDirectStatus(db, status, viewerId) : false;
  }
  return canViewNonDirect(db, status, viewerId);
};

/**
 * A cached remote status: public and unlisted ones are open to all but the
 * local accounts the author blocks, a followers-only one is shown to the
 * author's accepted local followers, and a direct or followers-only one to the
 * local accounts it addresses.
 */
export const canViewRemoteStatus = async (
  db: D1Database,
  status: RemoteStatus,
  viewerId: string | undefined,
): Promise<boolean> => {
  if (!viewerId) {
    return !Visibility.isRestricted(status.visibility);
  }
  if (!Visibility.isRestricted(status.visibility)) {
    const blocked = await findRemoteBlock(db, status.actorUri, viewerId);
    return blocked.isOk() && !blocked.value;
  }
  if (status.visibility.kind === "FollowersOnly") {
    const follow = await findOutboundFollow(db, viewerId, status.actorUri);
    if (follow.isOk() && OutboundFollow.relationship(follow.value).following) {
      return true;
    }
  }
  const mentioned = await isAccountMentionedOnRemoteStatus(db, status.id, viewerId);
  return mentioned.isOk() && mentioned.value;
};

/**
 * The ids among `locals` and `remotes` the viewer may see, each checked as
 * {@link canViewStatus} and {@link canViewRemoteStatus} check it.
 */
export const viewableStatusIds = async (
  db: D1Database,
  locals: ReadonlyArray<LocalStatus>,
  remotes: ReadonlyArray<RemoteStatus>,
  viewerId: string | undefined,
): Promise<ReadonlySet<string>> => {
  const checked = await Promise.all([
    ...locals.map(async (status) => ({
      id: status.id,
      viewable: await canViewStatus(db, status, viewerId),
    })),
    ...remotes.map(async (status) => ({
      id: status.id,
      viewable: await canViewRemoteStatus(db, status, viewerId),
    })),
  ]);
  return new Set(checked.flatMap(({ id, viewable }) => (viewable ? [id] : [])));
};

/**
 * A remote boost: a followers-only one is shown to the booster's accepted
 * local followers, and the boosted status must be visible to the viewer too.
 */
export const canViewRemoteBoost = async (
  db: D1Database,
  boost: RemoteBoost,
  viewerId: string | undefined,
): Promise<boolean> => {
  if (boost.visibility.kind === "FollowersOnly") {
    const follow = viewerId ? await findOutboundFollow(db, viewerId, boost.actorUri) : undefined;
    if (!follow?.isOk() || !OutboundFollow.relationship(follow.value).following) {
      return false;
    }
  }
  if (boost.target.kind === "LocalStatus") {
    const local = await findStatusById(db, boost.target.statusId);
    return local.isOk() && local.value !== undefined
      ? canViewStatus(db, local.value, viewerId)
      : false;
  }
  const remote = await findRemoteStatusById(db, boost.target.statusId);
  return remote.isOk() && remote.value !== undefined
    ? canViewRemoteStatus(db, remote.value, viewerId)
    : false;
};
