import {
  OutboundFollow,
  Visibility,
  type LocalStatus,
  type RemoteBoostValue as RemoteBoost,
  type RemoteStatus,
} from "@tstodon/domain";
import { ok, type Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import { listAuthorsBlockingViewerJson, listViewerStatusAccessJson } from "./generated/prisma/sql";
import { findRemoteStatusById } from "./remote-status-store";
import { findOutboundFollow } from "./outbound-follow-store";
import { findRemoteBlock } from "./remote-block-store";
import { findStatusById } from "./status-store";
import { queryTyped } from "./typed-sql";

const AuthorRow = z.object({ author: z.string() });
const GrantKind = z.enum(["Follow", "OutboundFollow", "Status", "RemoteStatus"]);
const GrantRow = z.object({ grant_kind: GrantKind, grant_key: z.string() });

/** A failed lookup counts as a block, so an error never shows a status. */
const blockedUnlessCleared = (found: Result<boolean, RepositoryError>): boolean =>
  found.isErr() || found.value;

/**
 * What decides a batch of statuses for one signed-in viewer, loaded once for
 * the whole batch: which authors (local account ids and remote actor URIs)
 * block the viewer, and which relations grant it a restricted status, as
 * `listViewerStatusAccessJson` names them (`Follow`, `OutboundFollow`,
 * `Status`, `RemoteStatus`).
 */
type ViewerAccess = Readonly<{
  blocks: (author: string) => boolean;
  granted: (kind: z.infer<typeof GrantKind>, key: string) => boolean;
}>;

const isDirectNote = (status: LocalStatus): boolean =>
  status.kind === "LocalNote" && status.visibility.kind === "Direct";

/**
 * Mastodon's `StatusPolicy#show?` for a local status. A public or unlisted
 * one is hidden only from viewers its author blocks. A followers-only one is
 * shown to the author, followers and the accounts it mentions. A direct note
 * is shown to its author and the accounts it mentions, and so is a direct
 * note replying through direct notes only to one they may see. A boost's own
 * visibility decides who sees it, and it is never direct. Viewers are local
 * accounts, so the policy's domain-block clause never applies.
 */
const canViewLocal = (
  status: LocalStatus,
  viewerId: string | undefined,
  access: ViewerAccess,
): boolean => {
  if (viewerId === status.accountId) {
    return true;
  }
  if (!Visibility.isRestricted(status.visibility)) {
    return viewerId === undefined || !access.blocks(status.accountId);
  }
  if (viewerId === undefined) {
    return false;
  }
  if (isDirectNote(status)) {
    return access.granted("Status", status.id);
  }
  return access.granted("Follow", status.accountId) || access.granted("Status", status.id);
};

/**
 * A cached remote status: public and unlisted ones are open to all but the
 * local accounts the author blocks, a followers-only one is shown to the
 * author's accepted local followers, and a direct or followers-only one to the
 * local accounts it addresses.
 */
const canViewRemote = (
  status: RemoteStatus,
  viewerId: string | undefined,
  access: ViewerAccess,
): boolean => {
  if (!Visibility.isRestricted(status.visibility)) {
    return viewerId === undefined || !access.blocks(status.actorUri);
  }
  if (viewerId === undefined) {
    return false;
  }
  return (
    (status.visibility.kind === "FollowersOnly" &&
      access.granted("OutboundFollow", status.actorUri)) ||
    access.granted("RemoteStatus", status.id)
  );
};

export const canViewStatus = async (
  db: D1Database,
  status: LocalStatus,
  viewerId: string | undefined,
): Promise<boolean> => (await viewableStatusIds(db, [status], [], viewerId)).has(status.id);

export const canViewRemoteStatus = async (
  db: D1Database,
  status: RemoteStatus,
  viewerId: string | undefined,
): Promise<boolean> => (await viewableStatusIds(db, [], [status], viewerId)).has(status.id);

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
 * The relations that grant `viewerId` the restricted statuses among `locals`
 * and `remotes`, as `kind key` entries, in one statement however many there are.
 */
const listViewerGrants = async (
  db: D1Database,
  viewerId: string,
  locals: ReadonlyArray<LocalStatus>,
  remotes: ReadonlyArray<RemoteStatus>,
): Promise<Result<ReadonlySet<string>, RepositoryError>> => {
  const restrictedLocals = locals.filter(
    (status) => status.accountId !== viewerId && Visibility.isRestricted(status.visibility),
  );
  const restrictedRemotes = remotes.filter((status) => Visibility.isRestricted(status.visibility));
  if (restrictedLocals.length === 0 && restrictedRemotes.length === 0) {
    return ok(new Set());
  }
  const [direct, followersOnly] = [
    restrictedLocals.filter(isDirectNote),
    restrictedLocals.filter((status) => !isDirectNote(status)),
  ];
  const ids = (statuses: ReadonlyArray<{ id: string }>) =>
    jsonStringArray(statuses.map((status) => status.id));
  const rows = await runD1(() =>
    queryTyped(
      db,
      listViewerStatusAccessJson(
        viewerId,
        jsonStringArray([...new Set(followersOnly.map((status) => status.accountId))]),
        jsonStringArray([
          ...new Set(
            restrictedRemotes.flatMap((status) =>
              status.visibility.kind === "FollowersOnly" ? [status.actorUri] : [],
            ),
          ),
        ]),
        ids(followersOnly),
        ids(direct),
        ids(restrictedRemotes),
      ),
      GrantRow,
    ),
  );
  return rows.map((found) => new Set(found.map((row) => `${row.grant_kind} ${row.grant_key}`)));
};

/** Log a failed access lookup; the caller then hides what it would have shown. */
const failedClosed = <T>(kind: string, found: Result<T, RepositoryError>): T | undefined => {
  if (found.isOk()) {
    return found.value;
  }
  console.error(JSON.stringify({ kind, message: found.error.message }));
  return undefined;
};

/**
 * The ids among `locals` and `remotes` the viewer may see, by Mastodon's
 * `StatusPolicy#show?`, in at most two statements however many there are: the
 * authors that block the viewer, and what grants it the restricted ones. A
 * caller that already holds a superset of those authors (local account ids
 * and remote actor URIs) passes it as `blockers` instead. A failed lookup
 * hides every status it would have decided.
 */
export const viewableStatusIds = async (
  db: D1Database,
  locals: ReadonlyArray<LocalStatus>,
  remotes: ReadonlyArray<RemoteStatus>,
  viewerId: string | undefined,
  blockers?: ReadonlySet<string>,
): Promise<ReadonlySet<string>> => {
  const [blocking, grants] =
    viewerId === undefined
      ? [ok(new Set<string>()), ok(new Set<string>())]
      : await Promise.all([
          blockers === undefined
            ? listAuthorsBlockingViewer(db, viewerId, locals, remotes)
            : ok(blockers),
          listViewerGrants(db, viewerId, locals, remotes),
        ]);
  const blocked = failedClosed("ViewerBlockersNotLoaded", blocking);
  const granted = failedClosed("ViewerGrantsNotLoaded", grants);
  const access: ViewerAccess = {
    blocks: (author) => blocked === undefined || blocked.has(author),
    granted: (kind, key) => granted?.has(`${kind} ${key}`) === true,
  };
  return new Set([
    ...locals.flatMap((status) => (canViewLocal(status, viewerId, access) ? [status.id] : [])),
    ...remotes.flatMap((status) => (canViewRemote(status, viewerId, access) ? [status.id] : [])),
  ]);
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
