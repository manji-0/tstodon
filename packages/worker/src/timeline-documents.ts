import { InstanceIdentity, type LocalStatus, type RemoteNote } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { attachFilteredToRemoteStatuses, attachFilteredToStatuses } from "./filter-match";
import type { FollowedFeed, ListFeed } from "./followed-feed";
import type { IdCursor } from "./id-cursor";
import { type AccountList, listListTimelineStatuses } from "./list-store";
import { mastodonStatuses } from "./local-status-documents";
import { listRemoteActorPinnedStatuses } from "./remote-actor-pin-store";
import { listActorRemoteBoosts, listFollowedRemoteBoosts } from "./remote-boost-store";
import { remoteBoostDocuments } from "./remote-boost-documents";
import { remoteStatusVisible } from "./remote-status-document";
import { mastodonRemoteStatuses } from "./remote-status-documents";
import {
  listActorRemoteStatuses,
  listFollowedRemoteStatuses,
  listPublicRemoteStatuses,
  listTagRemoteStatuses,
} from "./remote-status-timeline-store";
import { filterMutedThreads, mutedThreadStatusIds } from "./status-mute-store";
import { listTagStatuses, type TagStatusFilters } from "./status-discovery-store";
import {
  type AccountStatusFilters,
  listHomeStatuses,
  listPublicStatuses,
} from "./status-timeline-store";

/**
 * Remote statuses rendered for a timeline: the visible ones, for the viewer.
 * The queries already leave out blocked, muted, and domain-hidden actors
 * before their `LIMIT`, so a page is never cut short here. The retained statuses come back
 * alongside their documents so `filtered` can be attached to the same rows.
 */
export const remoteTimelineDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  remote: ReadonlyArray<RemoteNote>,
  viewerId: string | undefined,
  /** Direct notes already chosen for the viewer pass whatever their visibility. */
  visible: (status: RemoteNote) => boolean = remoteStatusVisible,
): Promise<
  Readonly<{
    statuses: RemoteNote[];
    documents: Record<string, unknown>[];
  }>
> => {
  const documents = await mastodonRemoteStatuses(env, identity, remote.filter(visible), viewerId);
  const rendered = new Set(documents.map((document) => document.id));
  return { statuses: remote.filter((status) => rendered.has(status.id)), documents };
};

/** Merge local and remote timeline documents, newest first (`min_id` oldest first). */
export const mergeTimelineDocuments = (
  local: ReadonlyArray<Record<string, unknown>>,
  remote: ReadonlyArray<Record<string, unknown>>,
  cursor: { minId?: string | undefined },
  limit: number,
): Record<string, unknown>[] => {
  const ascending = (cursor.minId ?? "").length > 0;
  return [...local, ...remote]
    .sort((left, right) => {
      const leftId = typeof left.id === "string" ? left.id : "";
      const rightId = typeof right.id === "string" ? right.id : "";
      return ascending ? leftId.localeCompare(rightId) : rightId.localeCompare(leftId);
    })
    .slice(0, limit);
};

/**
 * `local`/`remote` on a public or tag timeline: which side of the federation
 * it holds.
 */
export type TimelineScopes = Readonly<{ local: boolean; remote: boolean }>;

/**
 * Local and remote statuses of a public surface (the public or a tag
 * timeline), rendered for the viewer with `filtered` under the `public`
 * context, newest first. The queries already leave out the authors the
 * viewer blocks or mutes (and local ones who block the viewer), as
 * Mastodon's public feeds do, so a page is never cut short by them.
 */
const publicSurfaceDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string | undefined,
  local: Promise<Result<LocalStatus[], RepositoryError>> | undefined,
  remote: Promise<Result<RemoteNote[], RepositoryError>> | undefined,
  limit: number,
  cursor: IdCursor,
): Promise<Result<Record<string, unknown>[], RepositoryError>> => {
  const [localStatuses, remoteStatuses] = await Promise.all([
    local ?? Promise.resolve(ok([])),
    remote ?? Promise.resolve(ok([])),
  ]);
  if (localStatuses.isErr()) {
    return err(localStatuses.error);
  }
  if (remoteStatuses.isErr()) {
    return err(remoteStatuses.error);
  }
  const rendered =
    remoteStatuses.value.length === 0
      ? { statuses: [], documents: [] }
      : await remoteTimelineDocuments(env, identity, remoteStatuses.value, viewerId);
  const filteredLocal = await attachFilteredToStatuses(
    env.DB,
    viewerId,
    "public",
    localStatuses.value,
    await mastodonStatuses(env, identity, localStatuses.value, viewerId),
  );
  const filteredRemote = await attachFilteredToRemoteStatuses(
    env.DB,
    viewerId,
    "public",
    rendered.statuses,
    rendered.documents,
  );
  return ok(mergeTimelineDocuments(filteredLocal, filteredRemote, cursor, limit));
};

/**
 * The public timeline as the viewer sees it. This is the one definition of
 * what it holds: `GET /api/v1/timelines/public` pages it, and the public
 * streams ask it for one entry (`onlyId`) to decide whether a viewer hears
 * about that entry.
 */
export const publicTimelineDocuments = (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string | undefined,
  options: Readonly<{ scopes: TimelineScopes; onlyMedia: boolean }>,
  limit: number,
  cursor: IdCursor,
): Promise<Result<Record<string, unknown>[], RepositoryError>> =>
  publicSurfaceDocuments(
    env,
    identity,
    viewerId,
    options.scopes.local
      ? listPublicStatuses(env.DB, viewerId, limit, cursor, options.onlyMedia)
      : undefined,
    options.scopes.remote
      ? listPublicRemoteStatuses(env.DB, viewerId, limit, cursor, options.onlyMedia)
      : undefined,
    limit,
    cursor,
  );

/**
 * A tag timeline as the viewer sees it; like `publicTimelineDocuments`, the
 * hashtag streams ask it for one entry.
 */
export const tagTimelineDocuments = (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string | undefined,
  tag: string,
  options: Readonly<{ scopes: TimelineScopes; filters: TagStatusFilters }>,
  limit: number,
  cursor: IdCursor,
): Promise<Result<Record<string, unknown>[], RepositoryError>> =>
  publicSurfaceDocuments(
    env,
    identity,
    viewerId,
    options.scopes.local
      ? listTagStatuses(env.DB, viewerId, tag, limit, cursor, options.filters)
      : undefined,
    options.scopes.remote
      ? listTagRemoteStatuses(env.DB, viewerId, tag, limit, cursor, options.filters)
      : undefined,
    limit,
    cursor,
  );

/**
 * Followed remote actors' notes and boosts on one of the viewer's feeds (home
 * or a list), rendered for the viewer: without the conversations it muted,
 * with `filtered` on the notes its filters match.
 */
const followedRemoteDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string,
  feed: FollowedFeed,
  limit: number,
  cursor: IdCursor,
): Promise<Result<Record<string, unknown>[], RepositoryError>> => {
  const [remote, boosts] = await Promise.all([
    listFollowedRemoteStatuses(env.DB, viewerId, feed, limit, cursor),
    listFollowedRemoteBoosts(env.DB, viewerId, feed, limit, cursor),
  ]);
  if (remote.isErr()) {
    return err(remote.error);
  }
  if (boosts.isErr()) {
    return err(boosts.error);
  }
  const boostDocuments = await remoteBoostDocuments(env, identity, boosts.value, viewerId);
  if (boostDocuments.isErr()) {
    return err(boostDocuments.error);
  }
  const mutedRemote = await mutedThreadStatusIds(
    env.DB,
    identity,
    viewerId,
    remote.value.map((status) => status.id),
  );
  if (mutedRemote.isErr()) {
    return err(mutedRemote.error);
  }
  // The query already keeps followed actors' notes the viewer may see.
  const rendered = await remoteTimelineDocuments(
    env,
    identity,
    remote.value.filter((status) => !mutedRemote.value.has(status.id)),
    viewerId,
    () => true,
  );
  const filteredRemote = await attachFilteredToRemoteStatuses(
    env.DB,
    viewerId,
    "home",
    rendered.statuses,
    rendered.documents,
  );
  return ok([...filteredRemote, ...boostDocuments.value]);
};

/**
 * One feed's local statuses and followed remote actors' entries, merged and
 * rendered for the viewer: muted conversations left out, `filtered` attached.
 */
const feedDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string,
  feed: FollowedFeed,
  local: Promise<Result<LocalStatus[], RepositoryError>>,
  limit: number,
  cursor: IdCursor,
): Promise<Result<Record<string, unknown>[], RepositoryError>> => {
  const [statuses, remote] = await Promise.all([
    local,
    followedRemoteDocuments(env, identity, viewerId, feed, limit, cursor),
  ]);
  if (statuses.isErr()) {
    return err(statuses.error);
  }
  if (remote.isErr()) {
    return err(remote.error);
  }
  const visible = await filterMutedThreads(env.DB, viewerId, statuses.value);
  if (visible.isErr()) {
    return err(visible.error);
  }
  const filteredLocal = await attachFilteredToStatuses(
    env.DB,
    viewerId,
    "home",
    visible.value,
    await mastodonStatuses(env, identity, visible.value, viewerId),
  );
  return ok(mergeTimelineDocuments(filteredLocal, remote.value, cursor, limit));
};

/**
 * The viewer's home timeline as Mastodon statuses rendered for the viewer:
 * its own and followed accounts' statuses and boosts, followed remote actors'
 * notes and boosts, without what the viewer blocks or mutes (accounts, domains,
 * conversations), with `filtered` on what its filters match. This is the one definition of
 * what home holds: `GET /api/v1/timelines/home` pages it, and the streaming
 * fan-out asks it for one entry (`onlyId`) to decide whether a follower
 * hears about that entry.
 */
export const homeTimelineDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string,
  limit: number,
  cursor: IdCursor,
): Promise<Result<Record<string, unknown>[], RepositoryError>> =>
  feedDocuments(
    env,
    identity,
    viewerId,
    { kind: "Home" },
    listHomeStatuses(env.DB, viewerId, limit, cursor),
    limit,
    cursor,
  );

/**
 * The notes a remote actor pinned, in its order, as `pinned=true` on its
 * profile shows them: public and unlisted, with `filtered` on them.
 */
export const remoteAccountPinnedDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  actorUri: string,
  viewerId: string | undefined,
): Promise<Result<Record<string, unknown>[], RepositoryError>> => {
  const pinned = await listRemoteActorPinnedStatuses(env.DB, actorUri, viewerId);
  if (pinned.isErr()) {
    return err(pinned.error);
  }
  const rendered = await remoteTimelineDocuments(env, identity, pinned.value, viewerId, () => true);
  return ok([
    ...(await attachFilteredToRemoteStatuses(
      env.DB,
      viewerId,
      "public",
      rendered.statuses,
      rendered.documents,
    )),
  ]);
};

/**
 * A remote actor's profile timeline: its cached notes and boosts, newest
 * first, as the viewer may see them, with `filtered` on the notes. As in
 * Mastodon, `exclude_reblogs`, `only_media`, and `tagged` leave boosts out.
 * Only what this instance has received or backfilled from the actor's outbox
 * is there.
 */
export const remoteAccountTimelineDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  actorUri: string,
  viewerId: string | undefined,
  filters: AccountStatusFilters,
): Promise<Result<Record<string, unknown>[], RepositoryError>> => {
  const withBoosts =
    !filters.excludeReblogs && !filters.onlyMedia && (filters.tagged ?? "").length === 0;
  const [notes, boosts] = await Promise.all([
    listActorRemoteStatuses(env.DB, actorUri, viewerId, filters),
    withBoosts
      ? listActorRemoteBoosts(env.DB, actorUri, viewerId, filters.limit, filters.cursor)
      : Promise.resolve(ok([])),
  ]);
  if (notes.isErr()) {
    return err(notes.error);
  }
  if (boosts.isErr()) {
    return err(boosts.error);
  }
  const boostDocuments = await remoteBoostDocuments(env, identity, boosts.value, viewerId);
  if (boostDocuments.isErr()) {
    return err(boostDocuments.error);
  }
  // The query already keeps the notes the viewer may see.
  const rendered = await remoteTimelineDocuments(env, identity, notes.value, viewerId, () => true);
  const filteredNotes = await attachFilteredToRemoteStatuses(
    env.DB,
    viewerId,
    "public",
    rendered.statuses,
    rendered.documents,
  );
  return ok(
    mergeTimelineDocuments(
      filteredNotes,
      boostDocuments.value,
      filters.cursor ?? {},
      filters.limit,
    ),
  );
};

/**
 * One of the viewer's lists as a timeline, under home's rules: its local
 * members' statuses (by the list's `replies_policy`) and the notes and boosts
 * of its remote members, which the viewer follows.
 */
export const listTimelineDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string,
  list: AccountList,
  limit: number,
  cursor: IdCursor,
): Promise<Result<Record<string, unknown>[], RepositoryError>> => {
  const feed: ListFeed = {
    kind: "List",
    listId: list.id,
    repliesPolicy: list.repliesPolicy,
    localActorPrefix: InstanceIdentity.actorUrl(identity, ""),
  };
  return feedDocuments(
    env,
    identity,
    viewerId,
    feed,
    listListTimelineStatuses(env.DB, { feed, ownerAccountId: viewerId, limit, cursor }),
    limit,
    cursor,
  );
};
