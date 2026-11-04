import type { Context } from "hono";
import { authenticate } from "../auth";
import { attachFilteredToRemoteStatuses, attachFilteredToStatuses } from "../filter-match";
import { jsonAuthError, jsonRepositoryError, queryCursor, queryLimit, requireUser } from "../http";
import { mastodonStatuses } from "../local-status-documents";
import { elapsedMs, writeMetric } from "../metrics";
import { parseInstanceIdentity } from "../runtime-config";
import {
  listLinkRemoteStatuses,
  listRemoteDirectStatusesForAccount,
} from "../remote-status-timeline-store";
import { listDirectStatusesForAccount } from "../direct-status-store";
import { listLinkStatuses, type TagStatusFilters } from "../status-discovery-store";
import { isTruthy } from "../form-values";
import { findTrendingLinkUrl } from "../trend-store";
import { rejectedTrendTargets } from "../trend-review-store";
import { filterMutedThreads, mutedThreadStatusIds } from "../status-mute-store";
import {
  homeTimelineDocuments,
  mergeTimelineDocuments,
  publicTimelineDocuments,
  remoteTimelineDocuments,
  tagTimelineDocuments,
  type TimelineScopes,
} from "../timeline-documents";

/**
 * `local`/`remote` on a timeline (both documented): `local=true` keeps local
 * statuses, `remote=true` keeps remote ones, and neither or both keeps both.
 */
const timelineScopes = (c: Context<{ Bindings: Env }>): TimelineScopes => {
  const local = isTruthy(c.req.query("local"));
  const remote = isTruthy(c.req.query("remote"));
  if (!local && !remote) {
    return { local: true, remote: true };
  }
  return { local, remote };
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
  const documents = await publicTimelineDocuments(
    c.env,
    identity.value,
    auth.value.kind === "Account" ? auth.value.account.id : undefined,
    { scopes: timelineScopes(c), onlyMedia: isTruthy(c.req.query("only_media")) },
    queryLimit(c.req.query("limit")),
    queryCursor(c),
  );
  if (documents.isErr()) {
    return jsonRepositoryError(c, documents.error.message);
  }
  return c.json(documents.value);
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
  const documents = await homeTimelineDocuments(
    c.env,
    identity.value,
    user.value.id,
    queryLimit(c.req.query("limit")),
    queryCursor(c),
  );
  if (documents.isErr()) {
    return jsonRepositoryError(c, documents.error.message);
  }
  return c.json(documents.value);
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
  const documents = await tagTimelineDocuments(
    c.env,
    identity.value,
    auth.value.kind === "Account" ? auth.value.account.id : undefined,
    c.req.param("hashtag"),
    { scopes: timelineScopes(c), filters: tagStatusFilters(c) },
    queryLimit(c.req.query("limit")),
    queryCursor(c),
  );
  if (documents.isErr()) {
    return jsonRepositoryError(c, documents.error.message);
  }
  writeMetric(c.env, "timeline.tag", [elapsedMs(startedAt), documents.value.length], ["ok"]);
  return c.json(documents.value);
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
    listLinkStatuses(c.env.DB, viewerId, url.value, limit, cursor),
    listLinkRemoteStatuses(c.env.DB, viewerId, url.value, limit, cursor),
  ]);
  if (local.isErr()) {
    return jsonRepositoryError(c, local.error.message);
  }
  if (remote.isErr()) {
    return jsonRepositoryError(c, remote.error.message);
  }
  const localDocuments = await mastodonStatuses(c.env, identity.value, local.value, viewerId);
  const rendered = await remoteTimelineDocuments(c.env, identity.value, remote.value, viewerId);
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
  // Remote replies into a muted conversation stay out, as local ones do.
  const mutedRemote = await mutedThreadStatusIds(
    c.env.DB,
    identity.value,
    user.value.id,
    remote.value.map((status) => status.id),
  );
  if (mutedRemote.isErr()) {
    return jsonRepositoryError(c, mutedRemote.error.message);
  }
  const rendered = await remoteTimelineDocuments(
    c.env,
    identity.value,
    remote.value.filter((status) => !mutedRemote.value.has(status.id)),
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
