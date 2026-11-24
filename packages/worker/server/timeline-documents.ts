import type { ApiStatusJSON } from "@tstodon/api";
import {
  type InstanceIdentity,
  type LocalStatus,
  type RemoteNote,
  Visibility,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import {
  attachFilteredToRemoteStatuses,
  attachFilteredToStatuses,
  loadViewerFilters,
} from "./filter-match";
import type { FollowedFeed, ListFeed } from "./followed-feed";
import { type IdCursor, pageInOrder } from "./id-cursor";
import { type AccountList, listListTimelineStatuses } from "./list-store";
import { mastodonStatuses } from "./local-status-documents";
import { listRemoteActorPinnedStatuses } from "./remote-actor-pin-store";
import { listActorRemoteBoosts, listFollowedRemoteBoosts } from "./remote-boost-store";
import { remoteBoostDocuments } from "./remote-boost-documents";
import { mastodonRemoteStatuses } from "./remote-status-documents";
import {
  listActorRemoteStatuses,
  listFollowedRemoteStatuses,
  listFollowedTagRemoteStatuses,
  listPublicRemoteStatuses,
  listTagRemoteStatuses,
} from "./remote-status-timeline-store";
import { listTagStatuses, type TagStatusFilters } from "./status-discovery-store";
import {
  type AccountStatusFilters,
  findFollowedTagHorizon,
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

/**
 * A page of a timeline, newest first (a `min_id` page too, as Mastodon's
 * `paginate_by_min_id(...).reverse`), and its `Link` cursors: `next` is the
 * `max_id` of `rel="next"`, `prev` the `min_id` of `rel="prev"`. An empty page
 * has neither.
 */
export type TimelinePage = Readonly<{
  statuses: ApiStatusJSON[];
  next: string | undefined;
  prev: string | undefined;
  /**
   * Whether rows may follow the page: it is full, or a query read a full
   * `limit` (Mastodon's `records_continue?` over the rows read).
   */
  continues: boolean;
}>;

/** The rows one query of a merged page read: their ids are the page's cursors. */
export type FetchedRows = ReadonlyArray<Readonly<{ id: string }>>;

const pageOrder =
  (ascending: boolean) =>
  (left: Readonly<{ id: string }>, right: Readonly<{ id: string }>): number =>
    ascending ? left.id.localeCompare(right.id) : right.id.localeCompare(left.id);

/**
 * Where a page merged from several queries ends. A query that read a full
 * `limit` read nothing past its last row in page order, so an entry past the
 * earliest such row could pass over that query's unread rows: the page stops
 * there. A `horizon` (home's {@link findFollowedTagHorizon}) is such a bound
 * too: past it the followed hashtags were not read. `undefined` when there is
 * neither.
 */
const pageCut = (
  fetches: ReadonlyArray<FetchedRows>,
  ascending: boolean,
  limit: number,
  horizon: string | undefined,
): string | undefined =>
  [
    ...fetches.flatMap((rows) =>
      rows.length > 0 && rows.length >= limit ? rows.toSorted(pageOrder(ascending)).slice(-1) : [],
    ),
    ...(horizon === undefined ? [] : [{ id: horizon }]),
  ].toSorted(pageOrder(ascending))[0]?.id;

/** True when `id` is not past `cut` in page order. */
const withinCut = (id: string, cut: string | undefined, ascending: boolean): boolean =>
  cut === undefined || (ascending ? id <= cut : id >= cut);

/**
 * The page of `documents`, merged from the queries that read `fetches`: the
 * first `limit` in page order up to the queries' cut, or the `horizon` when
 * that comes first. A page the cut leaves short (an entry of a full query did
 * not render, or the horizon came first) continues from the cut, so the next
 * page neither skips nor repeats that query's rows. A page the horizon leaves
 * empty still continues from it, as an empty page with no `Link` ends the
 * timeline for a client.
 */
export const timelinePage = (
  documents: ReadonlyArray<ApiStatusJSON>,
  cursor: { minId?: string | undefined },
  limit: number,
  fetches: ReadonlyArray<FetchedRows> = [],
  horizon: string | undefined = undefined,
): TimelinePage => {
  const ascending = (cursor.minId ?? "").length > 0;
  const cut = pageCut(fetches, ascending, limit, horizon);
  const inOrder = documents
    .filter((document) => withinCut(document.id, cut, ascending))
    .toSorted(pageOrder(ascending))
    .slice(0, limit);
  const statuses = ascending ? inOrder.toReversed() : inOrder;
  const resume = inOrder.length < limit ? cut : undefined;
  if (statuses.length === 0) {
    return horizon === undefined || cut === undefined
      ? { statuses, next: undefined, prev: undefined, continues: false }
      : {
          statuses,
          next: ascending ? undefined : cut,
          prev: ascending ? cut : undefined,
          continues: true,
        };
  }
  return {
    statuses,
    next: ascending ? statuses.at(-1)?.id : (resume ?? statuses.at(-1)?.id),
    prev: ascending ? (resume ?? statuses[0]?.id) : statuses[0]?.id,
    continues: inOrder.length >= limit || cut !== undefined,
  };
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
 * {@link timelinePage} over sources that each fetched up to `limit` entries
 * (`fetches`, the rows each query read), rendering only the entries that can
 * reach the page: the first `limit` in page order up to the cut, then, only if
 * rendering left some of those out (an author it may not show), the rest. An
 * entry renders the same whichever others render with it, so the page is the
 * one rendering every entry gives.
 */
const renderMergedPage = async (
  sources: ReadonlyArray<PageSource>,
  fetches: ReadonlyArray<FetchedRows>,
  cursor: { minId?: string | undefined },
  limit: number,
  horizon: string | undefined = undefined,
): Promise<Result<TimelinePage, RepositoryError>> => {
  const ascending = (cursor.minId ?? "").length > 0;
  const cut = pageCut(fetches, ascending, limit, horizon);
  const ordered = sources
    .flatMap((source, index) => source.ids.map((id) => ({ id, index })))
    .filter((entry) => withinCut(entry.id, cut, ascending))
    .sort(pageOrder(ascending));
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
  return ok(timelinePage(rendered.flat(), cursor, limit, fetches, horizon));
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
): Promise<Result<TimelinePage, RepositoryError>> => {
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
    [localStatuses.value, remoteStatuses.value],
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
): Promise<Result<TimelinePage, RepositoryError>> =>
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
): Promise<Result<TimelinePage, RepositoryError>> =>
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
 * merged and rendered for the viewer, `filtered` attached. A muted
 * conversation stays, as Mastodon's `ConversationMute` silences only its
 * notifications.
 */
const feedDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string,
  feed: FollowedFeed,
  local: Promise<Result<LocalStatus[], RepositoryError>>,
  limit: number,
  cursor: IdCursor,
  horizon: string | undefined = undefined,
): Promise<Result<TimelinePage, RepositoryError>> => {
  const [statuses, followed, tagged, boosts] = await Promise.all([
    local,
    listFollowedRemoteStatuses(env.DB, viewerId, feed, limit, cursor),
    // A followed hashtag brings posts to home only, as in Mastodon.
    feed.kind === "Home"
      ? listFollowedTagRemoteStatuses(env.DB, viewerId, limit, cursor, horizon)
      : Promise.resolve(ok([])),
    listFollowedRemoteBoosts(env.DB, viewerId, feed, limit, cursor),
  ]);
  if (statuses.isErr()) {
    return err(statuses.error);
  }
  if (followed.isErr()) {
    return err(followed.error);
  }
  if (tagged.isErr()) {
    return err(tagged.error);
  }
  if (boosts.isErr()) {
    return err(boosts.error);
  }
  // A followed actor's note under a followed hashtag comes from both queries,
  // as Mastodon's two fan-out paths push it to the same home once.
  const listed = new Set(followed.value.map((note) => note.id));
  const remote = [...followed.value, ...tagged.value.filter((note) => !listed.has(note.id))];
  const filters = sharedRead(() => loadViewerFilters(env.DB, viewerId));
  return renderMergedPage(
    [
      pageSource(statuses.value, async (shown) =>
        (await mastodonStatuses(env, identity, shown, viewerId)).asyncMap((documents) =>
          attachFilteredToStatuses(env.DB, viewerId, "home", shown, documents, filters()),
        ),
      ),
      // The query already keeps followed actors' notes the viewer may see.
      pageSource(remote, async (shown) =>
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
    [statuses.value, followed.value, tagged.value, boosts.value],
    cursor,
    limit,
    horizon,
  );
};

/**
 * The viewer's home timeline as Mastodon statuses rendered for the viewer:
 * its own and followed accounts' statuses and boosts, followed remote actors'
 * notes and boosts, public notes under the hashtags it follows, posted since
 * it followed them, without what the viewer blocks or mutes (accounts and
 * domains), with `filtered` on what its filters match. This is the one definition of
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
): Promise<Result<TimelinePage, RepositoryError>> => {
  let page = cursor;
  for (let step = 1; ; step += 1) {
    const horizon = await findFollowedTagHorizon(env.DB, viewerId, page, limit);
    if (horizon.isErr()) {
      return err(horizon.error);
    }
    const documents = await feedDocuments(
      env,
      identity,
      viewerId,
      { kind: "Home" },
      listHomeStatuses(env.DB, viewerId, limit, page, horizon.value),
      limit,
      page,
      horizon.value,
    );
    // A page left empty by its horizon (a hidden flood under a followed
    // hashtag) is read again past the horizon, as an empty page tells a
    // client the timeline ended. A `since_id` page never moves past it.
    const next =
      documents.isOk() && documents.value.statuses.length === 0
        ? pastHorizon(page, horizon.value)
        : undefined;
    if (next === undefined || step >= HOME_HORIZON_STEPS) {
      return documents;
    }
    page = next;
  }
};

/** How many horizons one home request reads past before it answers an empty page. */
export const HOME_HORIZON_STEPS = 4;

/** The page after a horizon: below it, or above it for a `min_id` page. */
const pastHorizon = (cursor: IdCursor, horizon: string | undefined): IdCursor | undefined => {
  if (horizon === undefined || (cursor.onlyId ?? "") !== "" || (cursor.sinceId ?? "") !== "") {
    return undefined;
  }
  return (cursor.minId ?? "") !== "" ? { minId: horizon, maxId: cursor.maxId } : { maxId: horizon };
};

/**
 * The notes a remote actor pinned, in its order, as `pinned=true` on its
 * profile shows them: public and unlisted, under the profile's filters, with
 * `filtered` on them. A page of them by status id, as Mastodon pages an
 * account's `StatusPin`s; `ids` are the notes the page read, for its `Link`.
 */
export const remoteAccountPinnedDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  actorUri: string,
  viewerId: string | undefined,
  page: AccountStatusFilters,
): Promise<Result<Readonly<{ statuses: ApiStatusJSON[]; ids: string[] }>, RepositoryError>> => {
  const pinned = await listRemoteActorPinnedStatuses(env.DB, actorUri, viewerId, page);
  if (pinned.isErr()) {
    return err(pinned.error);
  }
  const read = pageInOrder(pinned.value, page.cursor ?? {}, page.limit);
  const rendered = await remoteTimelineDocuments(env, identity, read, viewerId, () => true);
  if (rendered.isErr()) {
    return err(rendered.error);
  }
  return ok({
    statuses: [
      ...(await attachFilteredToRemoteStatuses(
        env.DB,
        viewerId,
        "public",
        rendered.value.statuses,
        rendered.value.documents,
      )),
    ],
    ids: read.map((status) => status.id),
  });
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
): Promise<Result<TimelinePage, RepositoryError>> => {
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
    [notes.value, boosts.value],
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
): Promise<Result<TimelinePage, RepositoryError>> => {
  const feed: ListFeed = {
    kind: "List",
    listId: list.id,
    repliesPolicy: list.repliesPolicy,
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
