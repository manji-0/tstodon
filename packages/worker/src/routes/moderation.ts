import { Hono } from "hono";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readBody,
  requireUser,
} from "../http";
import { mastodonFilter, mastodonFilterV2 } from "../mastodon";
import { deleteFilter, insertFilter, insertReport, listFilters } from "../moderation-store";
import { FilterBodySchema, isTruthy, ReportBodySchema, stringList } from "../schemas";

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
  const body = await readBody(c, FilterBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const expiresIn = Number(body.value.expires_in);
  const expiresAt = Number.isFinite(expiresIn)
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : undefined;
  const row = await insertFilter(c.env.DB, {
    accountId: user.value.id,
    phrase: body.value.phrase.trim(),
    context: stringList(body.value.context).length > 0 ? stringList(body.value.context) : ["home"],
    wholeWord: isTruthy(body.value.whole_word),
    irreversible: isTruthy(body.value.irreversible),
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
  const body = await readBody(c, ReportBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const report = await insertReport(c.env.DB, {
    accountId: user.value.id,
    targetAccountId: body.value.account_id,
    statusIds: stringList(body.value.status_ids),
    comment: body.value.comment ?? "",
  });
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  return c.json({
    id: report.value.id,
    action_taken: false,
    action_taken_at: null,
    category: "other",
    comment: body.value.comment ?? "",
    forwarded: false,
    status_ids: stringList(body.value.status_ids),
    rule_ids: [],
    target_account: { id: body.value.account_id },
  });
});
