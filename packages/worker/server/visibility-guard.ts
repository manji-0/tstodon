import {
  OutboundFollow,
  Visibility,
  type LocalStatus,
  type RemoteBoostValue as RemoteBoost,
  type RemoteStatus,
  type Visibility as VisibilityValue,
} from "@tstodon/domain";
import { z } from "zod";
import { jsonStringArray, runD1 } from "./d1";
import {
  listFollowedAccountIds as listFollowedAccountIdsSql,
  listViewableDirectStatusIds as listViewableDirectStatusIdsSql,
} from "./generated/prisma/sql";
import { findRemoteStatusById } from "./remote-status-store";
import { isAccountMentionedOnStatus, listRemoteStatusMentions } from "./mention-store";
import { isAccountMentionedOnRemoteStatus } from "./mention-store";
import { acceptedOutboundFollowActorUris, findOutboundFollow } from "./outbound-follow-store";
import { queryTyped } from "./typed-sql";
import { relationshipFlags } from "./relationship-store";
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

/** Visible to everyone when public/unlisted, otherwise to the author and followers. */
const canViewRestricted = async (
  db: D1Database,
  visibility: VisibilityValue,
  authorId: string,
  viewerId: string | undefined,
): Promise<boolean> => {
  if (!Visibility.isRestricted(visibility)) {
    return true;
  }
  if (viewerId === authorId) {
    return true;
  }
  if (!viewerId) {
    return false;
  }
  const flags = await relationshipFlags(db, viewerId, authorId);
  return flags.isOk() && flags.value.following;
};

export const canViewStatus = async (
  db: D1Database,
  status: LocalStatus,
  viewerId: string | undefined,
): Promise<boolean> => {
  // A boost's own visibility decides who sees it; it is never direct.
  if (status.kind === "LocalReblog") {
    return canViewRestricted(db, status.visibility, status.accountId, viewerId);
  }
  if (status.visibility.kind === "Direct") {
    if (!viewerId) {
      return false;
    }
    return canViewDirectStatus(db, status, viewerId);
  }
  return canViewRestricted(db, status.visibility, status.accountId, viewerId);
};

/**
 * A cached remote status: public and unlisted ones are open, a followers-only
 * one is shown to the author's accepted local followers, and a direct or
 * followers-only one to the local accounts it addresses.
 */
export const canViewRemoteStatus = async (
  db: D1Database,
  status: RemoteStatus,
  viewerId: string | undefined,
): Promise<boolean> => {
  if (!Visibility.isRestricted(status.visibility)) {
    return true;
  }
  if (!viewerId) {
    return false;
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

const TargetAccountIdRow = z.object({ target_account_id: z.string() });
const StartIdRow = z.object({ start_id: z.string() });

/** Of `ids`, the ones a query over them returns; none when it fails, so nothing extra shows. */
const idsOrNone = async <Row>(
  ids: ReadonlyArray<string>,
  query: (idsJson: string) => Promise<Row[]>,
  idOf: (row: Row) => string,
): Promise<ReadonlySet<string>> => {
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await runD1(() => query(jsonStringArray([...new Set(ids)])));
  return new Set(rows.isOk() ? rows.value.map(idOf) : []);
};

/**
 * The ids among `locals` and `remotes` the viewer may see, each checked as
 * {@link canViewStatus} and {@link canViewRemoteStatus} check it, with the
 * follows and mentions behind the checks read once for all of them.
 */
export const viewableStatusIds = async (
  db: D1Database,
  locals: ReadonlyArray<LocalStatus>,
  remotes: ReadonlyArray<RemoteStatus>,
  viewerId: string | undefined,
): Promise<ReadonlySet<string>> => {
  if (viewerId === undefined) {
    return new Set(
      [...locals, ...remotes].flatMap((status) =>
        Visibility.isRestricted(status.visibility) ? [] : [status.id],
      ),
    );
  }
  const direct = locals.flatMap((status) =>
    status.kind === "LocalNote" && status.visibility.kind === "Direct" ? [status] : [],
  );
  const directIds = new Set(direct.map((status) => status.id));
  const followersOnly = locals.filter(
    (status) =>
      Visibility.isRestricted(status.visibility) &&
      !directIds.has(status.id) &&
      status.accountId !== viewerId,
  );
  const restrictedRemotes = remotes.filter((status) => Visibility.isRestricted(status.visibility));
  const [followed, directViewable, followedActors, mentions] = await Promise.all([
    idsOrNone(
      followersOnly.map((status) => status.accountId),
      (idsJson) => queryTyped(db, listFollowedAccountIdsSql(viewerId, idsJson), TargetAccountIdRow),
      (row) => row.target_account_id,
    ),
    idsOrNone(
      direct.map((status) => status.id),
      (idsJson) => queryTyped(db, listViewableDirectStatusIdsSql(viewerId, idsJson), StartIdRow),
      (row) => row.start_id,
    ),
    acceptedOutboundFollowActorUris(
      db,
      viewerId,
      restrictedRemotes.flatMap((status) =>
        status.visibility.kind === "FollowersOnly" ? [status.actorUri] : [],
      ),
    ),
    listRemoteStatusMentions(
      db,
      restrictedRemotes.map((status) => status.id),
    ),
  ]);
  const viewableLocal = (status: LocalStatus): boolean => {
    if (directIds.has(status.id)) {
      return directViewable.has(status.id);
    }
    return (
      !Visibility.isRestricted(status.visibility) ||
      status.accountId === viewerId ||
      followed.has(status.accountId)
    );
  };
  const viewableRemote = (status: RemoteStatus): boolean =>
    !Visibility.isRestricted(status.visibility) ||
    (status.visibility.kind === "FollowersOnly" &&
      followedActors.isOk() &&
      followedActors.value.has(status.actorUri)) ||
    (mentions.isOk() && (mentions.value.get(status.id) ?? []).includes(viewerId));
  return new Set([
    ...locals.flatMap((status) => (viewableLocal(status) ? [status.id] : [])),
    ...remotes.flatMap((status) => (viewableRemote(status) ? [status.id] : [])),
  ]);
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
