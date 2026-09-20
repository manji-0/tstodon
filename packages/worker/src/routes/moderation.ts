import { Hono } from "hono";
import {
  asBoolean,
  asStringArray,
  jsonAuthError,
  jsonRepositoryError,
  readObjectBody,
  requireUser,
} from "../http";
import { mastodonFilter, mastodonFilterV2 } from "../mastodon";
import {
  deleteFilter,
  insertFilter,
  insertReport,
  listFilters,
} from "../moderation-store";

export const moderationRoutes = new Hono<{ Bindings: Env }>();

moderationRoutes.get("/api/v1/filters", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const rows = await listFilters(c.env.DB, user.value.id);
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  return c.json(rows.value.map(mastodonFilter));
});

moderationRoutes.post("/api/v1/filters", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readObjectBody(c);
  if (typeof body.phrase !== "string" || body.phrase.trim().length === 0) {
    return c.json({ error: "phrase is required", kind: "ValidationError" }, 400);
  }
  const expiresIn = Number(body.expires_in);
  const expiresAt = Number.isFinite(expiresIn)
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : undefined;
  const row = await insertFilter(c.env.DB, {
    accountId: user.value.id,
    phrase: body.phrase.trim(),
    context: asStringArray(body.context).length > 0 ? asStringArray(body.context) : ["home"],
    wholeWord: asBoolean(body.whole_word),
    irreversible: asBoolean(body.irreversible),
    expiresAt,
  });
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  return c.json(mastodonFilter(row.value), 200);
});

moderationRoutes.delete("/api/v1/filters/:id", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const deleted = await deleteFilter(c.env.DB, user.value.id, c.req.param("id"));
  if (deleted.isErr()) {
    return jsonRepositoryError(c, deleted.error.message);
  }
  if (!deleted.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.body(null, 200);
});

moderationRoutes.get("/api/v2/filters", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const rows = await listFilters(c.env.DB, user.value.id);
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  return c.json(rows.value.map(mastodonFilterV2));
});

moderationRoutes.post("/api/v1/reports", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readObjectBody(c);
  if (typeof body.account_id !== "string" || body.account_id.length === 0) {
    return c.json({ error: "account_id is required", kind: "ValidationError" }, 400);
  }
  const report = await insertReport(c.env.DB, {
    accountId: user.value.id,
    targetAccountId: body.account_id,
    statusIds: asStringArray(body.status_ids),
    comment: typeof body.comment === "string" ? body.comment : "",
  });
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  return c.json({
    id: report.value.id,
    action_taken: false,
    action_taken_at: null,
    category: "other",
    comment: typeof body.comment === "string" ? body.comment : "",
    forwarded: false,
    status_ids: asStringArray(body.status_ids),
    rule_ids: [],
    target_account: { id: body.account_id },
  });
});
