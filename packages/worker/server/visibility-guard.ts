import {
  OutboundFollow,
  Visibility,
  type LocalStatus,
  type RemoteBoostValue as RemoteBoost,
  type RemoteStatus,
} from "@tstodon/domain";
import { ok, type Result } from "neverthrow";
import { z } from "zod";
import { findBlock } from "./block-mute-store";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import { listAuthorsBlockingViewerJson } from "./generated/prisma/sql";
import { findRemoteStatusById } from "./remote-status-store";
import { isAccountMentionedOnStatus } from "./mention-store";
import { isAccountMentionedOnRemoteStatus } from "./mention-store";
import { findOutboundFollow } from "./outbound-follow-store";
import { relationshipFlags } from "./relationship-store";
import { findRemoteBlock } from "./remote-block-store";
import { findStatusById } from "./status-store";
import { queryTyped } from "./typed-sql";

const AuthorRow = z.object({ author: z.string() });

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

/** Whether the status's author blocks `viewerId`, asked only when the policy needs it. */
type AuthorBlocks = (viewerId: string) => Promise<boolean>;

/** A failed lookup counts as a block, so an error never shows a status. */
const blockedUnlessCleared = (found: Result<boolean, RepositoryError>): boolean =>
  found.isErr() || found.value;

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
  authorBlocks: AuthorBlocks,
): Promise<boolean> => {
  if (viewerId === status.accountId) {
    return true;
  }
  if (!viewerId) {
    return !Visibility.isRestricted(status.visibility);
  }
  if (!Visibility.isRestricted(status.visibility)) {
    return !(await authorBlocks(viewerId));
  }
  const flags = await relationshipFlags(db, viewerId, status.accountId);
  if (flags.isOk() && flags.value.following) {
    return true;
  }
  const mentioned = await isAccountMentionedOnStatus(db, status.id, viewerId);
  return mentioned.isOk() && mentioned.value;
};

const canViewLocal = async (
  db: D1Database,
  status: LocalStatus,
  viewerId: string | undefined,
  authorBlocks: AuthorBlocks,
): Promise<boolean> => {
  // A boost's own visibility decides who sees it, and it is never direct.
  if (status.kind === "LocalNote" && status.visibility.kind === "Direct") {
    return viewerId ? canViewDirectStatus(db, status, viewerId) : false;
  }
  return canViewNonDirect(db, status, viewerId, authorBlocks);
};

export const canViewStatus = (
  db: D1Database,
  status: LocalStatus,
  viewerId: string | undefined,
): Promise<boolean> =>
  canViewLocal(db, status, viewerId, async (viewer) =>
    blockedUnlessCleared(await findBlock(db, status.accountId, viewer)),
  );

/**
 * A cached remote status: public and unlisted ones are open to all but the
 * local accounts the author blocks, a followers-only one is shown to the
 * author's accepted local followers, and a direct or followers-only one to the
 * local accounts it addresses.
 */
const canViewRemote = async (
  db: D1Database,
  status: RemoteStatus,
  viewerId: string | undefined,
  authorBlocks: AuthorBlocks,
): Promise<boolean> => {
  if (!viewerId) {
    return !Visibility.isRestricted(status.visibility);
  }
  if (!Visibility.isRestricted(status.visibility)) {
    return !(await authorBlocks(viewerId));
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

export const canViewRemoteStatus = (
  db: D1Database,
  status: RemoteStatus,
  viewerId: string | undefined,
): Promise<boolean> =>
  canViewRemote(db, status, viewerId, async (viewer) =>
    blockedUnlessCleared(await findRemoteBlock(db, status.actorUri, viewer)),
  );

/**
 * Which of the local accounts and remote actors that wrote `locals` and
 * `remotes` block `viewerId`, in one statement however many there are.
 */
const listAuthorsBlockingViewer = async (
  db: D1Database,
  viewerId: string,
  locals: ReadonlyArray<LocalStatus>,
  remotes: ReadonlyArray<RemoteStatus>,
): Promise<Result<ReadonlySet<string>, RepositoryError>> => {
  // Only a public or unlisted status asks whether its author blocks the viewer.
  const open = <T extends LocalStatus | RemoteStatus>(statuses: ReadonlyArray<T>) =>
    statuses.filter((status) => !Visibility.isRestricted(status.visibility));
  const accountIds = new Set(open(locals).map((status) => status.accountId));
  const actorUris = new Set(open(remotes).map((status) => status.actorUri));
  if (accountIds.size === 0 && actorUris.size === 0) {
    return ok(new Set());
  }
  const rows = await runD1(() =>
    queryTyped(
      db,
      listAuthorsBlockingViewerJson(
        viewerId,
        jsonStringArray([...accountIds]),
        jsonStringArray([...actorUris]),
      ),
      AuthorRow,
    ),
  );
  return rows.map((found) => new Set(found.map((row) => row.author)));
};

/**
 * The ids among `locals` and `remotes` the viewer may see, each checked as
 * {@link canViewStatus} and {@link canViewRemoteStatus} check it, with the
 * authors that block the viewer looked up once for all of them. A caller that
 * already holds a superset of those authors (local account ids and remote
 * actor URIs) passes it as `blockers` instead.
 */
export const viewableStatusIds = async (
  db: D1Database,
  locals: ReadonlyArray<LocalStatus>,
  remotes: ReadonlyArray<RemoteStatus>,
  viewerId: string | undefined,
  blockers?: ReadonlySet<string>,
): Promise<ReadonlySet<string>> => {
  const loaded =
    blockers !== undefined || viewerId === undefined
      ? ok(blockers ?? new Set<string>())
      : await listAuthorsBlockingViewer(db, viewerId, locals, remotes);
  const blocks = (author: string): AuthorBlocks =>
    loaded.isOk() ? async () => loaded.value.has(author) : async () => true;
  const checked = await Promise.all([
    ...locals.map(async (status) => ({
      id: status.id,
      viewable: await canViewLocal(db, status, viewerId, blocks(status.accountId)),
    })),
    ...remotes.map(async (status) => ({
      id: status.id,
      viewable: await canViewRemote(db, status, viewerId, blocks(status.actorUri)),
    })),
  ]);
  return new Set(checked.flatMap(({ id, viewable }) => (viewable ? [id] : [])));
};

/**
 * A remote boost, as `StatusPolicy#show?` sees the boost itself: a public or
 * unlisted one is hidden from the local accounts its booster blocks, a
 * followers-only one is shown to the booster's accepted local followers; and
 * the boosted status must be visible to the viewer too.
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
  } else if (
    viewerId &&
    blockedUnlessCleared(await findRemoteBlock(db, boost.actorUri, viewerId))
  ) {
    return false;
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
