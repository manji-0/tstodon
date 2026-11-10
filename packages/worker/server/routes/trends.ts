import { ApiGetTrendsParamsSchema, type ApiHashtagJSON } from "@tstodon/api";
import { warmSchemas } from "@tstodon/core";
import type { Context } from "hono";
import type { InstanceIdentity } from "@tstodon/domain";
import {
  jsonRepositoryError,
  jsonValidationError,
  queryLimit,
  queryOffset,
  queryTrendsLimit,
} from "../http";
import { readQueryParams } from "../request-params";
import { listTrendingLinks } from "../trend-store";
import { rejectedTrendTargets } from "../trend-review-store";
import { untrendableTags } from "../tag-moderation-store";
import { mastodonStatuses } from "../local-status-documents";
import { mastodonTag } from "../tag-documents";
import { authenticate } from "../auth";
import { listFeaturedTags, listFollowedTags, tagDailyHistories } from "../tag-store";
import { parseInstanceIdentity } from "../runtime-config";
import { listTrendingStatuses, listTrendingTags } from "../status-discovery-store";

export const getV1TrendsLinks = async (c: Context<{ Bindings: Env }, "/api/v1/trends/links">) => {
  const params = readQueryParams(c, ApiGetTrendsParamsSchema);
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
  const links = await listTrendingLinks(c.env.DB, {
    limit: queryTrendsLimit(params.value.limit),
    offset: queryOffset(params.value.offset),
    excluded: rejected.value,
    excludedPublishers: publishers.value,
  });
  if (links.isErr()) {
    return jsonRepositoryError(c, links.error.message);
  }
  return c.json(links.value.map((link) => link.document));
};

/** Trending tags as Tag documents with a real seven-day history. */
const trendingTagDocuments = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  names: ReadonlyArray<string>,
): Promise<ApiHashtagJSON[]> => {
  const auth = await authenticate(c.req.raw, c.env);
  const viewerId = auth.isOk() && auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const followed = new Set(
    viewerId ? (await listFollowedTags(c.env.DB, viewerId)).unwrapOr([]) : [],
  );
  const featured = new Set(
    viewerId ? (await listFeaturedTags(c.env.DB, viewerId)).unwrapOr([]) : [],
  );
  const histories = await tagDailyHistories(c.env.DB, names);
  return names.map((name) =>
    mastodonTag(identity, name, {
      history: (histories.isOk() ? histories.value.get(name) : undefined) ?? [],
      following: followed.has(name),
      featuring: featured.has(name),
    }),
  );
};

const trendingTagsResponse = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const params = readQueryParams(c, ApiGetTrendsParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  // Rejected in review, unusable, or unlisted.
  const rejected = await untrendableTags(c.env.DB);
  if (rejected.isErr()) {
    return jsonRepositoryError(c, rejected.error.message);
  }
  const tags = await listTrendingTags(c.env.DB, queryTrendsLimit(params.value.limit), {
    excluded: rejected.value,
    offset: queryOffset(params.value.offset),
  });
  if (tags.isErr()) {
    return jsonRepositoryError(c, tags.error.message);
  }
  return c.json(
    await trendingTagDocuments(
      c,
      identity.value,
      tags.value.map((tag) => tag.name),
    ),
  );
};

export const getV1Trends = trendingTagsResponse;
export const getV1TrendsTags = trendingTagsResponse;

export const getV1TrendsStatuses = async (
  c: Context<{ Bindings: Env }, "/api/v1/trends/statuses">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const params = readQueryParams(c, ApiGetTrendsParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const statuses = await listTrendingStatuses(c.env.DB, queryLimit(params.value.limit, 20), {
    offset: queryOffset(params.value.offset),
  });
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const documents = await mastodonStatuses(c.env, identity.value, statuses.value, undefined);
  return documents.isErr()
    ? jsonRepositoryError(c, documents.error.message)
    : c.json(documents.value);
};

warmSchemas([ApiGetTrendsParamsSchema]);
