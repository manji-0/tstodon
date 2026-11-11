import type { Context } from "hono";
import {
  ApiGetHomeTimelineParamsSchema,
  ApiGetLinkTimelineParamsSchema,
  ApiGetPublicTimelineParamsSchema,
  ApiGetTagTimelineParamsSchema,
  type ApiGetPublicTimelineParams,
  type ApiGetTagTimelineParams,
} from "@tstodon/api";
import { normalizeHashtag, warmSchemas } from "@tstodon/core";
import { authenticate } from "../auth";
import { attachFilteredToRemoteStatuses, attachFilteredToStatuses } from "../filter-match";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryLimit,
  requireUser,
} from "../http";
import { mastodonStatuses } from "../local-status-documents";
import { writeTimelineMetric } from "../metrics";
import { parseInstanceIdentity } from "../runtime-config";
import {
  listLinkRemoteStatuses,
  listRemoteDirectStatusesForAccount,
} from "../remote-status-timeline-store";
import { listDirectStatusesForAccount } from "../direct-status-store";
import { listLinkStatuses, type TagStatusFilters } from "../status-discovery-store";
import { paramsCursor, readQueryParams } from "../request-params";
import { findTrendingLinkUrl } from "../trend-store";
import { rejectedTrendTargets } from "../trend-review-store";
import { isTagUsable } from "../tag-moderation-store";
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
const timelineScopes = (params: ApiGetPublicTimelineParams): TimelineScopes => {
  const local = params.local ?? false;
  const remote = params.remote ?? false;
  if (!local && !remote) {
    return { local: true, remote: true };
  }
  return { local, remote };
};

export const getV1TimelinesPublic = async (
  c: Context<{ Bindings: Env }, "/api/v1/timelines/public">,
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
  const params = readQueryParams(c, ApiGetPublicTimelineParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const documents = await publicTimelineDocuments(
    c.env,
    identity.value,
    auth.value.kind === "Account" ? auth.value.account.id : undefined,
    { scopes: timelineScopes(params.value), onlyMedia: params.value.only_media ?? false },
    queryLimit(params.value.limit),
    paramsCursor(params.value),
  );
  writeTimelineMetric(
    c.env,
    "public",
    startedAt,
    documents.isOk() ? documents.value.length : undefined,
  );
  if (documents.isErr()) {
    return jsonRepositoryError(c, documents.error.message);
  }
  return c.json(documents.value);
};

export const getV1TimelinesHome = async (
  c: Context<{ Bindings: Env }, "/api/v1/timelines/home">,
) => {
  const startedAt = Date.now();
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const params = readQueryParams(c, ApiGetHomeTimelineParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const documents = await homeTimelineDocuments(
    c.env,
    identity.value,
    user.value.id,
    queryLimit(params.value.limit),
    paramsCursor(params.value),
  );
  writeTimelineMetric(
    c.env,
    "home",
    startedAt,
    documents.isOk() ? documents.value.length : undefined,
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

const tagStatusFilters = (params: ApiGetTagTimelineParams): TagStatusFilters => {
  const values = (list: ReadonlyArray<string> | undefined): string[] =>
    (list ?? []).map((value) => value.trim().replace(/^#/, "")).filter((value) => value.length > 0);
  const any: string[] = [];
  const all: string[] = [];
  const none: string[] = [];
  for (const [target, list] of [
    [any, values(params.any)],
    [all, values(params.all)],
    [none, values(params.none)],
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
  return { any, all, none, onlyMedia: params.only_media ?? false };
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
  const params = readQueryParams(c, ApiGetTagTimelineParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  // An admin made the tag unusable: its timeline lists nothing.
  const usable = await isTagUsable(c.env.DB, normalizeHashtag(c.req.param("hashtag") ?? ""));
  if (usable.isErr()) {
    return jsonRepositoryError(c, usable.error.message);
  }
  if (!usable.value) {
    return c.json([]);
  }
  const documents = await tagTimelineDocuments(
    c.env,
    identity.value,
    auth.value.kind === "Account" ? auth.value.account.id : undefined,
    c.req.param("hashtag"),
    { scopes: timelineScopes(params.value), filters: tagStatusFilters(params.value) },
    queryLimit(params.value.limit),
    paramsCursor(params.value),
  );
  writeTimelineMetric(
    c.env,
    "tag",
    startedAt,
    documents.isOk() ? documents.value.length : undefined,
  );
  if (documents.isErr()) {
    return jsonRepositoryError(c, documents.error.message);
  }
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
  const params = readQueryParams(c, ApiGetLinkTimelineParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const rejected = await rejectedTrendTargets(c.env.DB, "Link");
  if (rejected.isErr()) {
    return jsonRepositoryError(c, rejected.error.message);
  }
  const publishers = await rejectedTrendTargets(c.env.DB, "Publisher");
  if (publishers.isErr()) {
    return jsonRepositoryError(c, publishers.error.message);
  }
  const url = await findTrendingLinkUrl(
    c.env.DB,
    params.value.url ?? "",
    rejected.value,
    publishers.value,
  );
  if (url.isErr()) {
    return jsonRepositoryError(c, url.error.message);
  }
  if (!url.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const limit = queryLimit(params.value.limit);
  const cursor = paramsCursor(params.value);
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
  const [localDocuments, rendered] = await Promise.all([
    mastodonStatuses(c.env, identity.value, local.value, viewerId),
    remoteTimelineDocuments(c.env, identity.value, remote.value, viewerId),
  ]);
  if (localDocuments.isErr()) {
    return jsonRepositoryError(c, localDocuments.error.message);
  }
  if (rendered.isErr()) {
    return jsonRepositoryError(c, rendered.error.message);
  }
  const filteredLocal = await attachFilteredToStatuses(
    c.env.DB,
    viewerId,
    "public",
    local.value,
    localDocuments.value,
  );
  const filteredRemote = await attachFilteredToRemoteStatuses(
    c.env.DB,
    viewerId,
    "public",
    rendered.value.statuses,
    rendered.value.documents,
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
  const localDocuments = await mastodonStatuses(
    c.env,
    identity.value,
    visible.value,
    user.value.id,
  );
  if (localDocuments.isErr()) {
    return jsonRepositoryError(c, localDocuments.error.message);
  }
  const filteredLocal = await attachFilteredToStatuses(
    c.env.DB,
    user.value.id,
    "home",
    visible.value,
    localDocuments.value,
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
  if (rendered.isErr()) {
    return jsonRepositoryError(c, rendered.error.message);
  }
  const filteredRemote = await attachFilteredToRemoteStatuses(
    c.env.DB,
    user.value.id,
    "home",
    rendered.value.statuses,
    rendered.value.documents,
  );
  return c.json(mergeTimelineDocuments(filteredLocal, filteredRemote, {}, limit));
};

warmSchemas([
  ApiGetHomeTimelineParamsSchema,
  ApiGetPublicTimelineParamsSchema,
  ApiGetTagTimelineParamsSchema,
  ApiGetLinkTimelineParamsSchema,
]);
