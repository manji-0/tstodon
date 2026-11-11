import { normalizeHashtag } from "@tstodon/core";
import type { ApiAdminTagJSON } from "@tstodon/api";
import type { InstanceIdentity } from "@tstodon/domain";
import type { Context } from "hono";
import { z } from "zod";
import { reviewTrend } from "../../admin-trends";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAdminLimit,
  queryCursor,
  readBody,
  requireAdmin,
  setPaginationLinks,
} from "../../http";
import { parseInstanceIdentity } from "../../runtime-config";
import { mastodonTag } from "../../tag-documents";
import {
  findTagModeration,
  listTagModerationPage,
  saveTagModeration,
  type TagModeration,
} from "../../tag-moderation-store";
import { tagDailyHistories, type TagHistoryEntry } from "../../tag-store";
import { listTrendReviews, type TrendState } from "../../trend-review-store";
import { parseBool } from "./shared";

/**
 * `/api/v1/admin/tags` (Mastodon's `Api::V1::Admin::TagsController`):
 * the stored hashtags with what an admin decided about them. A tag is named
 * by its name here, so `:id` is the name.
 */

/**
 * `REST::Admin::TagSerializer` from the tag's moderation and its trend
 * review: an unreviewed tag may trend (tstodon reviews on rejection) and
 * still asks for review.
 */
export const adminTagDocument = (
  identity: InstanceIdentity,
  moderation: TagModeration,
  review: TrendState | undefined,
  history: ReadonlyArray<TagHistoryEntry>,
): ApiAdminTagJSON => ({
  ...mastodonTag(identity, moderation.name, { history }),
  name: moderation.displayName ?? moderation.name,
  trendable: review !== "Rejected",
  usable: moderation.usable,
  listable: moderation.listable,
  requires_review: review === undefined,
});

const notFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

const tagDocuments = async (
  db: D1Database,
  identity: InstanceIdentity,
  tags: ReadonlyArray<TagModeration>,
): Promise<ApiAdminTagJSON[] | Readonly<{ error: string }>> => {
  const [reviews, histories] = await Promise.all([
    listTrendReviews(db, "Tag"),
    tagDailyHistories(
      db,
      tags.map((tag) => tag.name),
    ),
  ]);
  if (reviews.isErr()) {
    return { error: reviews.error.message };
  }
  return tags.map((tag) =>
    adminTagDocument(
      identity,
      tag,
      reviews.value.get(tag.name),
      (histories.isOk() ? histories.value.get(tag.name) : undefined) ?? [],
    ),
  );
};

export const getV1AdminTags = async (c: Context<{ Bindings: Env }, "/api/v1/admin/tags">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const limit = queryAdminLimit(c.req.query("limit"));
  const tags = await listTagModerationPage(c.env.DB, queryCursor(c), limit);
  if (tags.isErr()) {
    return jsonRepositoryError(c, tags.error.message);
  }
  const documents = await tagDocuments(c.env.DB, identity.value, tags.value);
  if ("error" in documents) {
    return jsonRepositoryError(c, documents.error);
  }
  setPaginationLinks(
    c,
    tags.value.map((tag) => tag.name),
    limit,
  );
  return c.json(documents);
};

const tagResponse = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  tag: TagModeration,
): Promise<Response> => {
  const documents = await tagDocuments(c.env.DB, identity, [tag]);
  if ("error" in documents) {
    return jsonRepositoryError(c, documents.error);
  }
  const [document] = documents;
  return document ? c.json(document) : notFound(c);
};

export const getV1AdminTagsById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/tags/:id">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const tag = await findTagModeration(c.env.DB, normalizeHashtag(c.req.param("id") ?? ""));
  if (tag.isErr()) {
    return jsonRepositoryError(c, tag.error.message);
  }
  return tag.value ? tagResponse(c, identity.value, tag.value) : notFound(c);
};

const Flag = z.union([z.boolean(), z.string(), z.number()]).nullable().optional();

const TagUpdateBodySchema = z.object({
  display_name: z.string().nullable().optional(),
  trendable: Flag,
  usable: Flag,
  listable: Flag,
});

/**
 * `PUT /api/v1/admin/tags/:id`: `display_name` (another casing of the name;
 * blank clears it), `usable`, `listable` and `trendable`. Setting
 * `trendable` records the trend review as Mastodon does (`reviewed_at`), so
 * the tag no longer requires review.
 */
export const putV1AdminTagsById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/tags/:id">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const found = await findTagModeration(c.env.DB, normalizeHashtag(c.req.param("id") ?? ""));
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return notFound(c);
  }
  const body = await readBody(c, TagUpdateBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const current = found.value;
  const displayName = body.value.display_name?.trim();
  if (displayName && normalizeHashtag(displayName) !== current.name) {
    // Mastodon: the display name may only change the name's case.
    return c.json(
      { error: "Validation failed: Display name must match the hashtag", kind: "ValidationError" },
      422,
    );
  }
  const next: TagModeration = {
    ...current,
    usable:
      body.value.usable == null ? current.usable : parseBool(body.value.usable, current.usable),
    listable:
      body.value.listable == null
        ? current.listable
        : parseBool(body.value.listable, current.listable),
    displayName:
      body.value.display_name === undefined
        ? current.displayName
        : displayName && displayName.length > 0
          ? displayName.replace(/^#+/, "")
          : undefined,
  };
  const saved = await saveTagModeration(c.env.DB, next);
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  if (body.value.trendable != null) {
    const trendable = parseBool(body.value.trendable, true);
    const reviewed = await reviewTrend(
      c.env.DB,
      { kind: "Tag", name: current.name },
      trendable ? "Approved" : "Rejected",
    );
    if (reviewed.isErr()) {
      return reviewed.error.kind === "NotFound"
        ? notFound(c)
        : jsonRepositoryError(c, reviewed.error.message);
    }
  }
  return tagResponse(c, identity.value, next);
};
