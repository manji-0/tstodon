import type { ApiStatusJSON } from "@tstodon/api";
import { InstanceIdentity, type LocalStatus, type RemoteNote, Visibility } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import {
  attachFilteredToRemoteStatuses,
  attachFilteredToStatuses,
  loadViewerFilters,
} from "./filter-match";
import type { FollowedFeed, ListFeed } from "./followed-feed";
import type { IdCursor } from "./id-cursor";
import { type AccountList, listListTimelineStatuses } from "./list-store";
import { mastodonStatuses } from "./local-status-documents";
import { listRemoteActorPinnedStatuses } from "./remote-actor-pin-store";
import { listActorRemoteBoosts, listFollowedRemoteBoosts } from "./remote-boost-store";
import { remoteBoostDocuments } from "./remote-boost-documents";
import { mastodonRemoteStatuses } from "./remote-status-documents";
import {
  listActorRemoteStatuses,
  listFollowedRemoteStatuses,
  listPublicRemoteStatuses,
  listTagRemoteStatuses,
} from "./remote-status-timeline-store";
import { filterMutedThreads, listStatusMuteRoots, mutedThreadStatusIds } from "./status-mute-store";
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
  visible: (status: RemoteNote) => boolean = (status) =>
    !Visibility.isRestricted(status.visibility),
): Promise<
  Result<
    Readonly<{
      statuses: RemoteNote[];
      documents: ApiStatusJSON[];
    }>,
    RepositoryError
  >
> =>
  (await mastodonRemoteStatuses(env, identity, remote.filter(visible), viewerId)).map(
    (documents) => {
      const rendered = new Set(documents.map((document) => document.id));
      return { statuses: remote.filter((status) => rendered.has(status.id)), documents };
    },
  );

/** Merge local and remote timeline documents, newest first (`min_id` oldest first). */
export const mergeTimelineDocuments = (
  local: ReadonlyArray<ApiStatusJSON>,
  remote: ReadonlyArray<ApiStatusJSON>,
  cursor: { minId?: string | undefined },
  limit: number,
): ApiStatusJSON[] => {
  const ascending = (cursor.minId ?? "").length > 0;
  return [...local, ...remote]
    .sort((left, right) =>
      ascending ? left.id.localeCompare(right.id) : right.id.localeCompare(left.id),
    )
    .slice(0, limit);
};

/** `read`, run on first use; later uses share its result. */
const sharedRead = <T>(read: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => (pending ??= read());
};

/** One source of a merged page: its entries, and how to render some of them. */
type PageSource = Readonly<{
  ids: ReadonlyArray<string>;
  render: (
    ids: ReadonlySet<string>,
  ) => Promise<Result<ReadonlyArray<ApiStatusJSON>, RepositoryError>>;
}>;

const pageSource = <T extends Readonly<{ id: string }>>(
  entries: ReadonlyArray<T>,
  render: (
    entries: ReadonlyArray<T>,
  ) => Promise<Result<ReadonlyArray<ApiStatusJSON>, RepositoryError>>,
): PageSource => ({
  ids: entries.map((entry) => entry.id),
  render: (ids) => render(entries.filter((entry) => ids.has(entry.id))),
});

/**
 * {@link mergeTimelineDocuments} over sources that each fetched up to `limit`
 * entries, rendering only the entries that can reach the page: the first
 * `limit` in page order, then, only if rendering left some of those out (an
 * author it may not show), the rest. An entry renders the same whichever
 * others render with it, so the page is the one rendering every entry gives.
 */
const renderMergedPage = async (
  sources: ReadonlyArray<PageSource>,
  cursor: { minId?: string | undefined },
  limit: number,
): Promise<Result<ApiStatusJSON[], RepositoryError>> => {
  const ascending = (cursor.minId ?? "").length > 0;
  const ordered = sources
    .flatMap((source, index) => source.ids.map((id) => ({ id, index })))
    .sort((left, right) =>
      ascending ? left.id.localeCompare(right.id) : right.id.localeCompare(left.id),
    );
  const rendered: ApiStatusJSON[][] = sources.map(() => []);
  const renderEntries = async (
    entries: ReadonlyArray<{ id: string; index: number }>,
  ): Promise<Result<number, RepositoryError>> => {
    const results = await Promise.all(
      sources.map((source, index) => {
        const ids = new Set(entries.flatMap((entry) => (entry.index === index ? [entry.id] : [])));
        return ids.size === 0 ? Promise.resolve(ok([])) : source.render(ids);
      }),
    );
    let count = 0;
    for (const [index, result] of results.entries()) {
      if (result.isErr()) {
        return err(result.error);
      }
      rendered[index]?.push(...result.value);
      count += result.value.length;
    }
    return ok(count);
  };
  const first = await renderEntries(ordered.slice(0, limit));
  if (first.isErr()) {
    return err(first.error);
  }
  if (first.value < limit && ordered.length > limit) {
    const rest = await renderEntries(ordered.slice(limit));
    if (rest.isErr()) {
      return err(rest.error);
    }
  }
  return ok(mergeTimelineDocuments(rendered.flat(), [], cursor, limit));
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
): Promise<Result<ApiStatusJSON[], RepositoryError>> => {
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
  const filters =
    viewerId === undefined ? undefined : sharedRead(() => loadViewerFilters(env.DB, viewerId));
  return renderMergedPage(
    [
      pageSource(localStatuses.value, async (statuses) =>
        (await mastodonStatuses(env, identity, statuses, viewerId)).asyncMap((documents) =>
          attachFilteredToStatuses(env.DB, viewerId, "public", statuses, documents, filters?.()),
        ),
      ),
      pageSource(
        remoteStatuses.value.filter((status) => !Visibility.isRestricted(status.visibility)),
        async (statuses) =>
          (await remoteTimelineDocuments(env, identity, statuses, viewerId, () => true)).asyncMap(
            (rendered) =>
              attachFilteredToRemoteStatuses(
                env.DB,
                viewerId,
                "public",
                rendered.statuses,
                rendered.documents,
                filters?.(),
              ),
          ),
      ),
    ],
    cursor,
    limit,
  );
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
): Promise<Result<ApiStatusJSON[], RepositoryError>> =>
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
): Promise<Result<ApiStatusJSON[], RepositoryError>> =>
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
 * One feed's local statuses and followed remote actors' notes and boosts,
 * merged and rendered for the viewer: muted conversations left out,
 * `filtered` attached.
 */
const feedDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string,
  feed: FollowedFeed,
  local: Promise<Result<LocalStatus[], RepositoryError>>,
  limit: number,
  cursor: IdCursor,
): Promise<Result<ApiStatusJSON[], RepositoryError>> => {
  const mutedRoots = listStatusMuteRoots(env.DB, viewerId);
  const [statuses, remote, boosts] = await Promise.all([
    local,
    listFollowedRemoteStatuses(env.DB, viewerId, feed, limit, cursor),
    listFollowedRemoteBoosts(env.DB, viewerId, feed, limit, cursor),
  ]);
  if (statuses.isErr()) {
    return err(statuses.error);
  }
  if (remote.isErr()) {
    return err(remote.error);
  }
  if (boosts.isErr()) {
    return err(boosts.error);
  }
  const [visible, mutedRemote] = await Promise.all([
    filterMutedThreads(env.DB, viewerId, statuses.value, mutedRoots),
    mutedThreadStatusIds(
      env.DB,
      identity,
      viewerId,
      remote.value.map((status) => status.id),
      mutedRoots,
    ),
  ]);
  if (visible.isErr()) {
    return err(visible.error);
  }
  if (mutedRemote.isErr()) {
    return err(mutedRemote.error);
  }
  const filters = sharedRead(() => loadViewerFilters(env.DB, viewerId));
  return renderMergedPage(
    [
      pageSource(visible.value, async (shown) =>
        (await mastodonStatuses(env, identity, shown, viewerId)).asyncMap((documents) =>
          attachFilteredToStatuses(env.DB, viewerId, "home", shown, documents, filters()),
        ),
      ),
      // The query already keeps followed actors' notes the viewer may see.
      pageSource(
        remote.value.filter((status) => !mutedRemote.value.has(status.id)),
        async (shown) =>
          (await remoteTimelineDocuments(env, identity, shown, viewerId, () => true)).asyncMap(
            (rendered) =>
              attachFilteredToRemoteStatuses(
                env.DB,
                viewerId,
                "home",
                rendered.statuses,
                rendered.documents,
                filters(),
              ),
          ),
      ),
      pageSource(boosts.value, (shown) => remoteBoostDocuments(env, identity, shown, viewerId)),
    ],
    cursor,
    limit,
  );
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
): Promise<Result<ApiStatusJSON[], RepositoryError>> =>
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
): Promise<Result<ApiStatusJSON[], RepositoryError>> => {
  const pinned = await listRemoteActorPinnedStatuses(env.DB, actorUri, viewerId);
  if (pinned.isErr()) {
    return err(pinned.error);
  }
  const rendered = await remoteTimelineDocuments(env, identity, pinned.value, viewerId, () => true);
  if (rendered.isErr()) {
    return err(rendered.error);
  }
  return ok([
    ...(await attachFilteredToRemoteStatuses(
      env.DB,
      viewerId,
      "public",
      rendered.value.statuses,
      rendered.value.documents,
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
): Promise<Result<ApiStatusJSON[], RepositoryError>> => {
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
  return renderMergedPage(
    [
      // The query already keeps the notes the viewer may see.
      pageSource(notes.value, async (shown) =>
        (await remoteTimelineDocuments(env, identity, shown, viewerId, () => true)).asyncMap(
          (rendered) =>
            attachFilteredToRemoteStatuses(
              env.DB,
              viewerId,
              "public",
              rendered.statuses,
              rendered.documents,
            ),
        ),
      ),
      pageSource(boosts.value, (shown) => remoteBoostDocuments(env, identity, shown, viewerId)),
    ],
    filters.cursor ?? {},
    filters.limit,
  );
};

/**
 * One of the viewer's lists as a timeline, under home's rules: its local
 * members' statuses (by the list's `replies_policy`) and boosts, and the notes and boosts
 * of its remote members, which the viewer follows.
 */
export const listTimelineDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string,
  list: AccountList,
  limit: number,
  cursor: IdCursor,
): Promise<Result<ApiStatusJSON[], RepositoryError>> => {
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
