import { Hono } from "hono";
import { mastodonTag } from "../../tag-documents";
import type { Context } from "hono";
import type { InstanceIdentity } from "@tstodon/domain";
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
import { findStatusById, listTrendingStatuses, listTrendingTags } from "../../status-store";
import { tagDailyHistory } from "../../tag-store";
import { cardDocument, listCachedLinkCards } from "../../link-card";
import { fallbackLinkCard, listTrendingLinks } from "../../trend-store";
import { listTrendReviews, setTrendReview, type TrendState } from "../../trend-review-store";
import { StatusId } from "@tstodon/domain";

export const adminTrendRoutes = new Hono<{ Bindings: Env }>();

const adminTagFields = (state: TrendState | undefined): Record<string, unknown> => ({
  trendable: state !== "Rejected",
  usable: true,
  requires_review: state === undefined,
});

const adminTagDocument = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  name: string,
  state: TrendState | undefined,
): Promise<Record<string, unknown>> => ({
  ...mastodonTag(identity, name, {
    history: (await tagDailyHistory(c.env.DB, name)).unwrapOr([]),
  }),
  ...adminTagFields(state),
});

const notFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

adminTrendRoutes.get("/api/v1/admin/trends/tags", async (c) => {
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
  const documents = [];
  for (const tag of tags.value) {
    documents.push(await adminTagDocument(c, identity.value, tag.name, states.value.get(tag.name)));
  }
  return c.json(documents);
});

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
  if (name.length === 0) {
    return notFound(c);
  }
  const saved = await setTrendReview(c.env.DB, "Tag", name, state);
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  return c.json(await adminTagDocument(c, identity.value, name, state));
};

adminTrendRoutes.post("/api/v1/admin/trends/tags/:id/approve", reviewTag("Approved"));
adminTrendRoutes.post("/api/v1/admin/trends/tags/:id/reject", reviewTag("Rejected"));

adminTrendRoutes.get("/api/v1/admin/trends/links", async (c) => {
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
});

const reviewLink = (state: TrendState) => async (c: Context<{ Bindings: Env }>) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  // A link trend has no row id of its own, so the URL is its identifier.
  const url = c.req.param("id") ?? "";
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return notFound(c);
  }
  const saved = await setTrendReview(c.env.DB, "Link", url, state);
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  const cached = await listCachedLinkCards(c.env.DB, [url]);
  const preview = cached.get(url);
  return c.json(preview ? cardDocument(preview) : (fallbackLinkCard(url) ?? {}));
};

adminTrendRoutes.post("/api/v1/admin/trends/links/:id/approve", reviewLink("Approved"));
adminTrendRoutes.post("/api/v1/admin/trends/links/:id/reject", reviewLink("Rejected"));

adminTrendRoutes.get("/api/v1/admin/trends/statuses", async (c) => {
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
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, undefined));
});

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
  const found = await findStatusById(c.env.DB, id.value);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return notFound(c);
  }
  const saved = await setTrendReview(c.env.DB, "Status", raw, state);
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  return c.json(
    (await mastodonStatus(c.env, identity.value, found.value, admin.value.account.id)) ?? {},
  );
};

adminTrendRoutes.post("/api/v1/admin/trends/statuses/:id/approve", reviewStatus("Approved"));
adminTrendRoutes.post("/api/v1/admin/trends/statuses/:id/reject", reviewStatus("Rejected"));
