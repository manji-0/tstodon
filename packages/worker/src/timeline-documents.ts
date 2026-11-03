import type { InstanceIdentity, LocalStatus, RemoteNote } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { restrictedDomains, suspendedDomains } from "./admin-domain-block-store";
import type { RepositoryError } from "./d1";
import { listBlockedDomains } from "./domain-block-store";
import { attachFilteredToRemoteStatuses, attachFilteredToStatuses } from "./filter-match";
import type { FollowedFeed } from "./followed-feed";
import type { IdCursor } from "./id-cursor";
import { cardDocument, parseCardJson } from "./link-card";
import { type AccountList, listListTimelineStatuses } from "./list-store";
import { mastodonStatuses } from "./local-status-documents";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { listActorRemoteBoosts, listFollowedRemoteBoosts } from "./remote-boost-store";
import { remoteBoostDocuments } from "./remote-boost-documents";
import { findRemotePollVotes } from "./remote-poll-vote-store";
import { mastodonRemoteStatus, remoteStatusVisible } from "./remote-status-document";
import {
  listActorRemoteStatuses,
  listFollowedRemoteStatuses,
} from "./remote-status-timeline-store";
import { listRemoteStatusCards } from "./status-card-store";
import { attachRemoteReplyRefs } from "./status-documents";
import { filterMutedThreads, mutedThreadStatusIds } from "./status-mute-store";
import { type AccountStatusFilters, listHomeStatuses } from "./status-timeline-store";

/**
 * Remote statuses rendered for a timeline: the visible ones whose actor is not
 * on a blocked domain, with their preview card. The retained statuses come back
 * alongside their documents so `filtered` can be attached to the same rows.
 */
export const remoteTimelineDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  remote: ReadonlyArray<RemoteNote>,
  viewerId: string | undefined,
  /** Direct notes already chosen for the viewer pass whatever their visibility. */
  visible: (status: RemoteNote) => boolean = remoteStatusVisible,
  /** Instance domain blocks that hide statuses; followers still see silenced ones. */
  hiddenDomains: (db: D1Database) => Promise<ReadonlySet<string>> = restrictedDomains,
): Promise<
  Readonly<{
    statuses: RemoteNote[];
    documents: Record<string, unknown>[];
    cards: ReadonlyMap<string, string>;
  }>
> => {
  const blockedDomains = viewerId ? await listBlockedDomains(env.DB, viewerId) : undefined;
  const blocked = new Set(
    (blockedDomains?.isOk() ? blockedDomains.value : []).map((domain) => domain.toLowerCase()),
  );
  for (const domain of await hiddenDomains(env.DB)) {
    blocked.add(domain);
  }
  const cards = await listRemoteStatusCards(
    env.DB,
    remote.map((status) => status.id),
  );
  const actors = await findRemoteActorsByUris(
    env.DB,
    remote.map((status) => status.actorUri),
  );
  const pollVotes = await findRemotePollVotes(env.DB, viewerId, remote);
  const statuses: RemoteNote[] = [];
  const documents: Record<string, unknown>[] = [];
  for (const status of remote) {
    const actor = actors.isOk() ? actors.value.get(status.actorUri) : undefined;
    if (!actor || !visible(status)) {
      continue;
    }
    if (blocked.has(actor.domain.toLowerCase())) {
      continue;
    }
    const rawCard = cards.isOk() ? cards.value.get(status.id) : undefined;
    const card = rawCard ? parseCardJson(rawCard) : undefined;
    statuses.push(status);
    documents.push(
      mastodonRemoteStatus(
        identity,
        status,
        actor,
        card ? cardDocument(card) : null,
        pollVotes.get(status.id),
      ),
    );
  }
  await attachRemoteReplyRefs(env.DB, identity, documents);
  return { statuses, documents, cards: cards.isOk() ? cards.value : new Map() };
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
    suspendedDomains,
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
 * A remote actor's profile timeline: its cached notes and boosts, newest
 * first, as the viewer may see them, with `filtered` on the notes. As in
 * Mastodon, `exclude_reblogs`, `only_media`, and `tagged` leave boosts out.
 * Only what this instance has received is there; the actor's outbox is not
 * fetched.
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
  const rendered = await remoteTimelineDocuments(
    env,
    identity,
    notes.value,
    viewerId,
    () => true,
    suspendedDomains,
  );
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
): Promise<Result<Record<string, unknown>[], RepositoryError>> =>
  feedDocuments(
    env,
    identity,
    viewerId,
    { kind: "List", listId: list.id, repliesPolicy: list.repliesPolicy },
    listListTimelineStatuses(env.DB, {
      listId: list.id,
      ownerAccountId: viewerId,
      repliesPolicy: list.repliesPolicy,
      limit,
      cursor,
    }),
    limit,
    cursor,
  );
