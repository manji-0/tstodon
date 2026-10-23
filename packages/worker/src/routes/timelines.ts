import type { Context } from "hono";
import type {
  InstanceIdentity,
  LocalStatus as LocalStatusValue,
  RemoteNote,
} from "@tstodon/domain";
import { authenticate } from "../auth";
import { restrictedDomains } from "../admin-domain-block-store";
import { listBlockedDomains } from "../domain-block-store";
import { attachFilteredToRemoteStatuses, attachFilteredToStatuses } from "../filter-match";
import { cardDocument, parseCardJson } from "../link-card";
import { jsonAuthError, jsonRepositoryError, queryCursor, queryLimit, requireUser } from "../http";
import { mastodonRemoteStatus, remoteStatusVisible } from "../remote-status-document";
import { mastodonStatuses } from "../local-status-documents";
import { elapsedMs, writeMetric } from "../metrics";
import { parseInstanceIdentity } from "../runtime-config";
import { findRemoteActorsByUris } from "../remote-actor-store";
import { attachRemoteReplyRefs } from "../status-documents";
import {
  listLinkRemoteStatuses,
  listPublicRemoteStatuses,
  listRemoteDirectStatusesForAccount,
  listTagRemoteStatuses,
} from "../remote-status-timeline-store";
import { listRemoteStatusCards } from "../status-card-store";
import { listDirectStatusesForAccount } from "../direct-status-store";
import { listHomeStatuses, listPublicStatuses } from "../status-timeline-store";
import {
  listLinkStatuses,
  listTagStatuses,
  type TagStatusFilters,
} from "../status-discovery-store";
import { isTruthy } from "../form-values";
import { findTrendingLinkUrl } from "../trend-store";
import { rejectedTrendTargets } from "../trend-review-store";
import { filterMutedThreads } from "../status-mute-store";

/**
 * `local`/`remote` on a timeline (both documented): `local=true` keeps local
 * statuses, `remote=true` keeps remote ones, and neither or both keeps both.
 */
const timelineScopes = (
  c: Context<{ Bindings: Env }>,
): Readonly<{ local: boolean; remote: boolean }> => {
  const local = isTruthy(c.req.query("local"));
  const remote = isTruthy(c.req.query("remote"));
  if (!local && !remote) {
    return { local: true, remote: true };
  }
  return { local, remote };
};

/**
 * Remote statuses rendered for a timeline: the visible ones whose actor is not
 * on a blocked domain, with their preview card. The retained statuses come back
 * alongside their documents so `filtered` can be attached to the same rows.
 */
const remoteTimelineDocuments = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  remote: ReadonlyArray<RemoteNote>,
  viewerId: string | undefined,
  /** Direct notes already chosen for the viewer pass whatever their visibility. */
  visible: (status: RemoteNote) => boolean = remoteStatusVisible,
): Promise<
  Readonly<{
    statuses: RemoteNote[];
    documents: Record<string, unknown>[];
    cards: ReadonlyMap<string, string>;
  }>
> => {
  const blockedDomains = viewerId ? await listBlockedDomains(c.env.DB, viewerId) : undefined;
  const blocked = new Set(
    (blockedDomains?.isOk() ? blockedDomains.value : []).map((domain) => domain.toLowerCase()),
  );
  for (const domain of await restrictedDomains(c.env.DB)) {
    blocked.add(domain);
  }
  const cards = await listRemoteStatusCards(
    c.env.DB,
    remote.map((status) => status.id),
  );
  const actors = await findRemoteActorsByUris(
    c.env.DB,
    remote.map((status) => status.actorUri),
  );
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
    documents.push(mastodonRemoteStatus(identity, status, actor, card ? cardDocument(card) : null));
  }
  await attachRemoteReplyRefs(c.env.DB, identity, documents);
  return { statuses, documents, cards: cards.isOk() ? cards.value : new Map() };
};

/** Merge local and remote timeline documents, newest first (`min_id` oldest first). */
const mergeTimelineDocuments = (
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

export const getV1TimelinesPublic = async (
  c: Context<{ Bindings: Env }, "/api/v1/timelines/public">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const scopes = timelineScopes(c);
  const limit = queryLimit(c.req.query("limit"));
  const cursor = queryCursor(c);
  const localDocuments: Record<string, unknown>[] = [];
  const localStatuses: LocalStatusValue[] = [];
  if (scopes.local) {
    const statuses = await listPublicStatuses(c.env.DB, limit, cursor);
    if (statuses.isErr()) {
      return jsonRepositoryError(c, statuses.error.message);
    }
    localStatuses.push(...statuses.value);
    localDocuments.push(
      ...(await mastodonStatuses(c.env, identity.value, statuses.value, viewerId)),
    );
  }
  const remoteDocuments: Record<string, unknown>[] = [];
  let remoteStatuses: RemoteNote[] = [];
  if (scopes.remote) {
    const remote = await listPublicRemoteStatuses(c.env.DB, limit);
    if (remote.isErr()) {
      return jsonRepositoryError(c, remote.error.message);
    }
    const rendered = await remoteTimelineDocuments(c, identity.value, remote.value, viewerId);
    remoteStatuses = [...rendered.statuses];
    remoteDocuments.push(...rendered.documents);
  }
  const filteredLocal = await attachFilteredToStatuses(
    c.env.DB,
    viewerId,
    "public",
    localStatuses,
    localDocuments,
  );
  const filteredRemote = await attachFilteredToRemoteStatuses(
    c.env.DB,
    viewerId,
    "public",
    remoteStatuses,
    remoteDocuments,
  );
  return c.json(mergeTimelineDocuments(filteredLocal, filteredRemote, cursor, limit));
};

export const getV1TimelinesHome = async (
  c: Context<{ Bindings: Env }, "/api/v1/timelines/home">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const statuses = await listHomeStatuses(
    c.env.DB,
    user.value.id,
    queryLimit(c.req.query("limit")),
    queryCursor(c),
  );
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const visible = await filterMutedThreads(c.env.DB, user.value.id, statuses.value);
  if (visible.isErr()) {
    return jsonRepositoryError(c, visible.error.message);
  }
  return c.json(
    await attachFilteredToStatuses(
      c.env.DB,
      user.value.id,
      "home",
      visible.value,
      await mastodonStatuses(c.env, identity.value, visible.value, user.value.id),
    ),
  );
};

/**
 * Mastodon's `any[]`/`all[]`/`none[]` on a tag timeline. Both the `name[]` and
 * `name` forms are accepted, a leading `#` is dropped, and — as the API
 * documents — at most four additional tags are applied, `any` first.
 */
const TAG_FILTER_LIMIT = 4;

const tagStatusFilters = (c: Context<{ Bindings: Env }>): TagStatusFilters => {
  const values = (key: string): string[] =>
    [...(c.req.queries(`${key}[]`) ?? []), ...(c.req.queries(key) ?? [])]
      .map((value) => value.trim().replace(/^#/, ""))
      .filter((value) => value.length > 0);
  const any: string[] = [];
  const all: string[] = [];
  const none: string[] = [];
  for (const [target, list] of [
    [any, values("any")],
    [all, values("all")],
    [none, values("none")],
  ] as const) {
    for (const value of list) {
      if (any.length + all.length + none.length >= TAG_FILTER_LIMIT) {
        break;
      }
      if (!target.includes(value)) {
        target.push(value);
      }
    }
  }
  return { any, all, none, onlyMedia: isTruthy(c.req.query("only_media")) };
};

export const getV1TimelinesTagByHashtag = async (
  c: Context<{ Bindings: Env }, "/api/v1/timelines/tag/:hashtag">,
) => {
  const startedAt = Date.now();
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const scopes = timelineScopes(c);
  const limit = queryLimit(c.req.query("limit"));
  const cursor = queryCursor(c);
  const filters = tagStatusFilters(c);
  const localDocuments: Record<string, unknown>[] = [];
  let localStatuses: LocalStatusValue[] = [];
  if (scopes.local) {
    const statuses = await listTagStatuses(
      c.env.DB,
      c.req.param("hashtag"),
      limit,
      cursor,
      filters,
    );
    if (statuses.isErr()) {
      return jsonRepositoryError(c, statuses.error.message);
    }
    localStatuses = [...statuses.value];
    localDocuments.push(
      ...(await mastodonStatuses(c.env, identity.value, statuses.value, viewerId)),
    );
  }
  const remoteDocuments: Record<string, unknown>[] = [];
  let remoteStatuses: RemoteNote[] = [];
  if (scopes.remote) {
    const remote = await listTagRemoteStatuses(
      c.env.DB,
      c.req.param("hashtag"),
      limit,
      cursor,
      filters,
    );
    if (remote.isErr()) {
      return jsonRepositoryError(c, remote.error.message);
    }
    const rendered = await remoteTimelineDocuments(c, identity.value, remote.value, viewerId);
    remoteStatuses = [...rendered.statuses];
    remoteDocuments.push(...rendered.documents);
  }
  const filteredLocal = await attachFilteredToStatuses(
    c.env.DB,
    viewerId,
    "public",
    localStatuses,
    localDocuments,
  );
  const filteredRemote = await attachFilteredToRemoteStatuses(
    c.env.DB,
    viewerId,
    "public",
    remoteStatuses,
    remoteDocuments,
  );
  const documents = mergeTimelineDocuments(filteredLocal, filteredRemote, cursor, limit);
  writeMetric(c.env, "timeline.tag", [elapsedMs(startedAt), documents.length], ["ok"]);
  return c.json(documents);
};

/**
 * Public statuses whose preview card is a trending link (`url`), like
 * Mastodon's link timeline; a link that is not trending answers 404.
 */
export const getV1TimelinesLink = async (
  c: Context<{ Bindings: Env }, "/api/v1/timelines/link">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const rejected = await rejectedTrendTargets(c.env.DB, "Link");
  if (rejected.isErr()) {
    return jsonRepositoryError(c, rejected.error.message);
  }
  const url = await findTrendingLinkUrl(c.env.DB, c.req.query("url") ?? "", rejected.value);
  if (url.isErr()) {
    return jsonRepositoryError(c, url.error.message);
  }
  if (!url.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const limit = queryLimit(c.req.query("limit"));
  const cursor = queryCursor(c);
  const [local, remote] = await Promise.all([
    listLinkStatuses(c.env.DB, url.value, limit, cursor),
    listLinkRemoteStatuses(c.env.DB, url.value, limit, cursor),
  ]);
  if (local.isErr()) {
    return jsonRepositoryError(c, local.error.message);
  }
  if (remote.isErr()) {
    return jsonRepositoryError(c, remote.error.message);
  }
  const localDocuments = await mastodonStatuses(c.env, identity.value, local.value, viewerId);
  const rendered = await remoteTimelineDocuments(c, identity.value, remote.value, viewerId);
  const filteredLocal = await attachFilteredToStatuses(
    c.env.DB,
    viewerId,
    "public",
    local.value,
    localDocuments,
  );
  const filteredRemote = await attachFilteredToRemoteStatuses(
    c.env.DB,
    viewerId,
    "public",
    rendered.statuses,
    rendered.documents,
  );
  return c.json(mergeTimelineDocuments(filteredLocal, filteredRemote, cursor, limit));
};

export const getV1TimelinesDirect = async (
  c: Context<{ Bindings: Env }, "/api/v1/timelines/direct">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const limit = queryLimit(c.req.query("limit"));
  const maxId = c.req.query("max_id");
  const [statuses, remote] = await Promise.all([
    listDirectStatusesForAccount(c.env.DB, user.value.id, limit, maxId),
    listRemoteDirectStatusesForAccount(c.env.DB, user.value.id, limit, maxId),
  ]);
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  if (remote.isErr()) {
    return jsonRepositoryError(c, remote.error.message);
  }
  const visible = await filterMutedThreads(c.env.DB, user.value.id, statuses.value);
  if (visible.isErr()) {
    return jsonRepositoryError(c, visible.error.message);
  }
  const filteredLocal = await attachFilteredToStatuses(
    c.env.DB,
    user.value.id,
    "home",
    visible.value,
    await mastodonStatuses(c.env, identity.value, visible.value, user.value.id),
  );
  const rendered = await remoteTimelineDocuments(
    c,
    identity.value,
    remote.value,
    user.value.id,
    () => true,
  );
  const filteredRemote = await attachFilteredToRemoteStatuses(
    c.env.DB,
    user.value.id,
    "home",
    rendered.statuses,
    rendered.documents,
  );
  return c.json(mergeTimelineDocuments(filteredLocal, filteredRemote, {}, limit));
};
