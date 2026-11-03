import type { InstanceIdentity, RemoteNote } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { restrictedDomains, suspendedDomains } from "./admin-domain-block-store";
import type { RepositoryError } from "./d1";
import { listBlockedDomains } from "./domain-block-store";
import { attachFilteredToRemoteStatuses, attachFilteredToStatuses } from "./filter-match";
import type { IdCursor } from "./id-cursor";
import { cardDocument, parseCardJson } from "./link-card";
import { mastodonStatuses } from "./local-status-documents";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { listHomeRemoteBoosts } from "./remote-boost-store";
import { remoteBoostDocuments } from "./remote-boost-documents";
import { findRemotePollVotes } from "./remote-poll-vote-store";
import { mastodonRemoteStatus, remoteStatusVisible } from "./remote-status-document";
import { listHomeRemoteStatuses } from "./remote-status-timeline-store";
import { listRemoteStatusCards } from "./status-card-store";
import { attachRemoteReplyRefs } from "./status-documents";
import { filterMutedThreads, mutedThreadStatusIds } from "./status-mute-store";
import { listHomeStatuses } from "./status-timeline-store";

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
 * The viewer's home timeline as Mastodon statuses rendered for the viewer:
 * its own and followed accounts' statuses and boosts, followed remote actors'
 * notes and boosts, without what the viewer blocks, mutes (accounts, domains,
 * conversations) or has filtered out to hide. This is the one definition of
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
): Promise<Result<Record<string, unknown>[], RepositoryError>> => {
  const [statuses, remote, boosts] = await Promise.all([
    listHomeStatuses(env.DB, viewerId, limit, cursor),
    listHomeRemoteStatuses(env.DB, viewerId, limit, cursor),
    listHomeRemoteBoosts(env.DB, viewerId, limit, cursor),
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
  const boostDocuments = await remoteBoostDocuments(env, identity, boosts.value, viewerId);
  if (boostDocuments.isErr()) {
    return err(boostDocuments.error);
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
  return ok(
    mergeTimelineDocuments(
      filteredLocal,
      [...filteredRemote, ...boostDocuments.value],
      cursor,
      limit,
    ),
  );
};
