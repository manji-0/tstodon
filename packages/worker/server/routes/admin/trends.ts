import type { ApiAdminPreviewCardProviderJSON, ApiAdminTagJSON } from "@tstodon/api";
import { StatusAuthors } from "../../account-presentation";
import type { Context } from "hono";
import {
  jsonAuthError,
  jsonRepositoryError,
  queryLimit,
  queryOffset,
  queryTrendsLimit,
  requireAdmin,
} from "../../http";
import { mastodonStatus, mastodonStatuses } from "../../local-status-documents";
import { parseInstanceIdentity } from "../../runtime-config";
import { findStatusById } from "../../status-store";
import { listTrendingStatuses, listTrendingTags } from "../../status-discovery-store";
import { tagDailyHistories, tagDailyHistory } from "../../tag-store";
import { cardDocument, listCachedLinkCards } from "../../link-card";
import { fallbackLinkCard, listTrendingLinks, trendingLinkPublishers } from "../../trend-store";
import {
  listTrendReviewRecords,
  listTrendReviews,
  type TrendState,
} from "../../trend-review-store";
import {
  defaultTagModeration,
  findTagModeration,
  tagModerations,
} from "../../tag-moderation-store";
import { adminTagDocument } from "./tags";
import { type ReviewTrendError, reviewTrend } from "../../admin-trends";
import { Hostname, StatusId } from "@tstodon/domain";

const notFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

const reviewFailure = (c: Context<{ Bindings: Env }>, error: ReviewTrendError) =>
  error.kind === "NotFound" ? notFound(c) : jsonRepositoryError(c, error.message);

export const getV1AdminTrendsTags = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/trends/tags">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const states = await listTrendReviews(c.env.DB, "Tag");
  if (states.isErr()) {
    return jsonRepositoryError(c, states.error.message);
  }
  const tags = await listTrendingTags(c.env.DB, queryTrendsLimit(c.req.query("limit")), {
    offset: queryOffset(c.req.query("offset")),
  });
  if (tags.isErr()) {
    return jsonRepositoryError(c, tags.error.message);
  }
  const names = tags.value.map((tag) => tag.name);
  const [histories, moderations] = await Promise.all([
    tagDailyHistories(c.env.DB, names),
    tagModerations(c.env.DB, names),
  ]);
  if (moderations.isErr()) {
    return jsonRepositoryError(c, moderations.error.message);
  }
  return c.json(
    names.map((name): ApiAdminTagJSON =>
      adminTagDocument(
        identity.value,
        moderations.value.get(name) ?? defaultTagModeration(name),
        states.value.get(name),
        (histories.isOk() ? histories.value.get(name) : undefined) ?? [],
      ),
    ),
  );
};

const reviewTag = (state: TrendState) => async (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const name = (c.req.param("id") ?? "").trim();
  const saved = await reviewTrend(c.env.DB, { kind: "Tag", name }, state);
  if (saved.isErr()) {
    return reviewFailure(c, saved.error);
  }
  const [moderation, history] = await Promise.all([
    findTagModeration(c.env.DB, name),
    tagDailyHistory(c.env.DB, name),
  ]);
  return c.json(
    adminTagDocument(
      identity.value,
      (moderation.isOk() ? moderation.value : undefined) ?? defaultTagModeration(name),
      state,
      history.unwrapOr([]),
    ),
  );
};

export const postV1AdminTrendsTagsByIdApprove = reviewTag("Approved");
export const postV1AdminTrendsTagsByIdReject = reviewTag("Rejected");

export const getV1AdminTrendsLinks = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/trends/links">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const links = await listTrendingLinks(c.env.DB, {
    limit: queryTrendsLimit(c.req.query("limit")),
    offset: queryOffset(c.req.query("offset")),
  });
  if (links.isErr()) {
    return jsonRepositoryError(c, links.error.message);
  }
  return c.json(links.value.map((link) => link.document));
};

const reviewLink = (state: TrendState) => async (c: Context<{ Bindings: Env }>) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  // A link trend has no row id of its own, so the URL is its identifier.
  const url = c.req.param("id") ?? "";
  const saved = await reviewTrend(c.env.DB, { kind: "Link", url }, state);
  if (saved.isErr()) {
    return reviewFailure(c, saved.error);
  }
  const cached = await listCachedLinkCards(c.env.DB, [url]);
  const preview = cached.get(url);
  return c.json(preview ? cardDocument(preview) : (fallbackLinkCard(url) ?? {}));
};

export const postV1AdminTrendsLinksByIdApprove = reviewLink("Approved");
export const postV1AdminTrendsLinksByIdReject = reviewLink("Rejected");

export const getV1AdminTrendsStatuses = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/trends/statuses">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  // The admin list keeps rejected statuses so a moderator can approve them.
  const statuses = await listTrendingStatuses(c.env.DB, queryLimit(c.req.query("limit")), {
    includeRejected: true,
    offset: queryOffset(c.req.query("offset")),
  });
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const documents = await mastodonStatuses(c.env, identity.value, statuses.value, undefined);
  return documents.isErr()
    ? jsonRepositoryError(c, documents.error.message)
    : c.json(documents.value);
};

const reviewStatus = (state: TrendState) => async (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const raw = c.req.param("id") ?? "";
  const id = StatusId.parse(raw);
  if (id.isErr()) {
    return notFound(c);
  }
  const saved = await reviewTrend(c.env.DB, { kind: "Status", id: raw }, state);
  if (saved.isErr()) {
    return reviewFailure(c, saved.error);
  }
  const found = await findStatusById(c.env.DB, id.value);
  if (found.isErr() || !found.value) {
    return notFound(c);
  }
  const document = await mastodonStatus(
    c.env,
    identity.value,
    found.value,
    admin.value.account.id,
    StatusAuthors.any,
  );
  if (document.isErr()) {
    return jsonRepositoryError(c, document.error.message);
  }
  return document.value ? c.json(document.value) : notFound(c);
};

export const postV1AdminTrendsStatusesByIdApprove = reviewStatus("Approved");
export const postV1AdminTrendsStatusesByIdReject = reviewStatus("Rejected");

/**
 * `REST::Admin::Trends::Links::PreviewCardProviderSerializer`: a publisher
 * (named by its host) is trendable unless rejected, as tstodon reviews
 * trends on rejection.
 */
const publisherDocument = (
  domain: string,
  review: Readonly<{ state: TrendState; reviewedAt: string }> | undefined,
): ApiAdminPreviewCardProviderJSON => ({
  id: domain,
  domain,
  trendable: review?.state !== "Rejected",
  reviewed_at: review?.reviewedAt ?? null,
  requested_review_at: null,
  requires_review: review === undefined,
});

/**
 * `GET /api/v1/admin/trends/links/publishers`: the publishers of the links
 * trending now, then the reviewed ones that are not, most shared first.
 * Publishers have no row id, so the list pages by `offset`.
 */
export const getV1AdminTrendsLinksPublishers = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/trends/links/publishers">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const [trending, reviews] = await Promise.all([
    trendingLinkPublishers(c.env.DB),
    listTrendReviewRecords(c.env.DB, "Publisher"),
  ]);
  if (trending.isErr()) {
    return jsonRepositoryError(c, trending.error.message);
  }
  if (reviews.isErr()) {
    return jsonRepositoryError(c, reviews.error.message);
  }
  const domains = [
    ...new Set([
      ...trending.value.map((publisher) => publisher.domain),
      ...[...reviews.value.keys()].toSorted(),
    ]),
  ];
  const offset = queryOffset(c.req.query("offset"));
  const limit = queryTrendsLimit(c.req.query("limit"));
  return c.json(
    domains
      .slice(offset, offset + limit)
      .map((domain) => publisherDocument(domain, reviews.value.get(domain))),
  );
};

const reviewPublisher = (state: TrendState) => async (c: Context<{ Bindings: Env }>) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const domain = Hostname.fromInput(c.req.param("id") ?? "") ?? "";
  const saved = await reviewTrend(c.env.DB, { kind: "Publisher", domain }, state);
  if (saved.isErr()) {
    return reviewFailure(c, saved.error);
  }
  const reviews = await listTrendReviewRecords(c.env.DB, "Publisher");
  if (reviews.isErr()) {
    return jsonRepositoryError(c, reviews.error.message);
  }
  return c.json(publisherDocument(domain, reviews.value.get(domain)));
};

export const postV1AdminTrendsLinksPublishersByIdApprove = reviewPublisher("Approved");
export const postV1AdminTrendsLinksPublishersByIdReject = reviewPublisher("Rejected");
