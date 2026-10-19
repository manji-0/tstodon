import { Hono } from "hono";
import type { Context } from "hono";
import type { z } from "zod";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readBody,
  requireUser,
} from "../http";
import { newEntityId } from "../ids";
import { authenticate } from "../auth";
import { mastodonFilter, mastodonFilterV2, mastodonStatuses } from "../mastodon";
import { parseInstanceIdentity } from "../runtime-config";
import { findStatusesByIds } from "../status-store";
import {
  addFilterStatuses,
  deleteFilter,
  filterKeywords,
  findFilterById,
  insertFilter,
  insertReport,
  listFilterStatusIds,
  listFilters,
  removeFilterStatus,
  updateFilter,
  type FilterKeyword,
} from "../moderation-store";
import {
  FilterBodySchema,
  FilterKeywordBodySchema,
  FilterStatusesBodySchema,
  FilterV2BodySchema,
  isTruthy,
  ReportBodySchema,
  stringList,
} from "../schemas";

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

moderationRoutes.post("/api/v2/filters", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readBody(c, FilterV2BodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const keywords = keywordsFromBody(body.value);
  const title = (body.value.title ?? body.value.phrase ?? "").trim();
  const phrase = title.length > 0 ? title : (keywords[0]?.keyword ?? "");
  if (phrase.length === 0) {
    return c.json({ error: "title is required", kind: "ValidationError" }, 422);
  }
  const contexts = stringList(body.value.context);
  const created = await insertFilter(c.env.DB, {
    accountId: user.value.id,
    phrase,
    context: contexts.length > 0 ? contexts : ["home"],
    wholeWord: keywords[0]?.whole_word ?? false,
    irreversible:
      body.value.filter_action !== undefined
        ? body.value.filter_action === "hide"
        : isTruthy(body.value.irreversible),
    expiresAt: expiresAtFromBody(body.value.expires_in) ?? undefined,
    keywords,
  });
  if (created.isErr()) {
    return jsonRepositoryError(c, created.error.message);
  }
  return c.json(mastodonFilterV2(created.value), 200);
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
  const documents: Record<string, unknown>[] = [];
  for (const row of rows.value) {
    const statusIds = await listFilterStatusIds(c.env.DB, row.id);
    documents.push(
      mastodonFilterV2(
        row,
        await filterStatusDocuments(c, statusIds.isOk() ? statusIds.value : []),
      ),
    );
  }
  return c.json(documents);
});

/** Keywords from either `keywords_attributes[]` or `keywords[]`, in order. */
const keywordsFromBody = (
  body: z.infer<typeof FilterV2BodySchema>,
  extra: ReadonlyArray<{
    id?: string | undefined;
    keyword?: string | undefined;
    whole_word?: boolean;
  }> = [],
): FilterKeyword[] => {
  const entries = [
    ...(body.keywords_attributes ?? []).filter((entry) => !isTruthy(entry._destroy)),
    ...(body.keywords ?? []).map((entry) =>
      typeof entry === "string" ? { keyword: entry } : entry,
    ),
    ...extra,
  ];
  const keywords: FilterKeyword[] = [];
  for (const entry of entries) {
    const keyword = entry.keyword?.trim() ?? "";
    if (keyword.length === 0) {
      continue;
    }
    keywords.push({
      id: entry.id && entry.id.length > 0 ? entry.id : newEntityId(),
      keyword,
      whole_word: entry.whole_word !== undefined ? isTruthy(entry.whole_word) : false,
    });
  }
  return keywords;
};

const expiresAtFromBody = (raw: number | string | undefined): string | null => {
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + seconds * 1000).toISOString()
    : null;
};

const filterNotFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

moderationRoutes.get("/api/v2/filters/:id", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const row = await findFilterById(c.env.DB, user.value.id, c.req.param("id"));
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return filterNotFound(c);
  }
  const statusIds = await listFilterStatusIds(c.env.DB, row.value.id);
  return c.json(
    mastodonFilterV2(
      row.value,
      await filterStatusDocuments(c, statusIds.isOk() ? statusIds.value : []),
    ),
  );
});

moderationRoutes.put("/api/v2/filters/:id", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const id = c.req.param("id") ?? "";
  const existing = await findFilterById(c.env.DB, user.value.id, id);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (!existing.value) {
    return filterNotFound(c);
  }
  const body = await readBody(c, FilterV2BodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  // Omitted keywords keep whatever the filter already had.
  const keywordsProvided =
    body.value.keywords !== undefined || body.value.keywords_attributes !== undefined;
  const keywords = keywordsProvided ? keywordsFromBody(body.value) : filterKeywords(existing.value);
  const title = (body.value.title ?? body.value.phrase ?? "").trim();
  const phrase = title.length > 0 ? title : (keywords[0]?.keyword ?? existing.value.phrase);
  const contexts = stringList(body.value.context);
  const action = body.value.filter_action;
  const updated = await updateFilter(c.env.DB, user.value.id, id, {
    phrase,
    context: contexts.length > 0 ? contexts : (JSON.parse(existing.value.context_json) as string[]),
    wholeWord: keywords[0]?.whole_word ?? existing.value.whole_word === 1,
    irreversible: action === undefined ? existing.value.irreversible === 1 : action === "hide",
    expiresAt:
      body.value.expires_in === undefined
        ? existing.value.expires_at
        : expiresAtFromBody(body.value.expires_in),
    keywords,
  });
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }
  const row = await findFilterById(c.env.DB, user.value.id, id);
  if (row.isErr() || !row.value) {
    return filterNotFound(c);
  }
  const statusIds = await listFilterStatusIds(c.env.DB, row.value.id);
  return c.json(
    mastodonFilterV2(
      row.value,
      await filterStatusDocuments(c, statusIds.isOk() ? statusIds.value : []),
    ),
  );
});

moderationRoutes.delete("/api/v2/filters/:id", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const deleted = await deleteFilter(c.env.DB, user.value.id, c.req.param("id"));
  if (deleted.isErr()) {
    return jsonRepositoryError(c, deleted.error.message);
  }
  if (!deleted.value) {
    return filterNotFound(c);
  }
  return c.json({});
});

moderationRoutes.get("/api/v2/filters/:id/keywords", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const row = await findFilterById(c.env.DB, user.value.id, c.req.param("id"));
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return filterNotFound(c);
  }
  return c.json(filterKeywords(row.value));
});

const writeKeywords = async (
  c: Context<{ Bindings: Env }>,
  keywords: ReadonlyArray<FilterKeyword>,
): Promise<Response> => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const id = c.req.param("id") ?? "";
  const row = await findFilterById(c.env.DB, user.value.id, id);
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return filterNotFound(c);
  }
  const updated = await updateFilter(c.env.DB, user.value.id, id, {
    phrase: keywords[0]?.keyword ?? row.value.phrase,
    context: JSON.parse(row.value.context_json) as string[],
    wholeWord: keywords[0]?.whole_word ?? row.value.whole_word === 1,
    irreversible: row.value.irreversible === 1,
    expiresAt: row.value.expires_at,
    keywords,
  });
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }
  return c.json({});
};

moderationRoutes.post("/api/v2/filters/:id/keywords", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const row = await findFilterById(c.env.DB, user.value.id, c.req.param("id"));
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return filterNotFound(c);
  }
  const body = await readBody(c, FilterKeywordBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const keyword = (body.value.keyword ?? "").trim();
  if (keyword.length === 0) {
    return c.json({ error: "keyword is required", kind: "ValidationError" }, 422);
  }
  const existing = filterKeywords(row.value);
  if (existing.some((entry) => entry.keyword.toLowerCase() === keyword.toLowerCase())) {
    return c.json({ error: "keyword has already been added", kind: "ValidationError" }, 422);
  }
  const appended: FilterKeyword = {
    id: newEntityId(),
    keyword,
    whole_word: isTruthy(body.value.whole_word),
  };
  const response = await writeKeywords(c, [...existing, appended]);
  if (response.status !== 200) {
    return response;
  }
  return c.json(appended);
});

moderationRoutes.put("/api/v2/filters/:id/keywords/:keywordId", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const row = await findFilterById(c.env.DB, user.value.id, c.req.param("id"));
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return filterNotFound(c);
  }
  const keywordId = c.req.param("keywordId") ?? "";
  const existing = filterKeywords(row.value);
  const current = existing.find((entry) => entry.id === keywordId);
  if (!current) {
    return filterNotFound(c);
  }
  const body = await readBody(c, FilterKeywordBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const keyword =
    body.value.keyword === undefined || body.value.keyword.trim().length === 0
      ? current.keyword
      : body.value.keyword.trim();
  const next: FilterKeyword = {
    id: current.id,
    keyword,
    whole_word:
      body.value.whole_word === undefined ? current.whole_word : isTruthy(body.value.whole_word),
  };
  const response = await writeKeywords(
    c,
    existing.map((entry) => (entry.id === keywordId ? next : entry)),
  );
  if (response.status !== 200) {
    return response;
  }
  return c.json(next);
});

moderationRoutes.delete("/api/v2/filters/:id/keywords/:keywordId", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const row = await findFilterById(c.env.DB, user.value.id, c.req.param("id"));
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return filterNotFound(c);
  }
  const keywordId = c.req.param("keywordId") ?? "";
  const existing = filterKeywords(row.value);
  if (!existing.some((entry) => entry.id === keywordId)) {
    return filterNotFound(c);
  }
  const remaining = existing.filter((entry) => entry.id !== keywordId);
  if (remaining.length === 0) {
    return c.json({ error: "a filter needs at least one keyword", kind: "ValidationError" }, 422);
  }
  const response = await writeKeywords(c, remaining);
  if (response.status !== 200) {
    return response;
  }
  return c.json({});
});

const filterStatusDocuments = async (
  c: Context<{ Bindings: Env }>,
  statusIds: ReadonlyArray<string>,
): Promise<Record<string, unknown>[]> => {
  if (statusIds.length === 0) {
    return [];
  }
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return [];
  }
  const found = await findStatusesByIds(c.env.DB, statusIds);
  if (found.isErr()) {
    return [];
  }
  const auth = await authenticate(c.req.raw, c.env);
  const viewerId = auth.isOk() && auth.value.kind === "Account" ? auth.value.account.id : undefined;
  return mastodonStatuses(c.env, identity.value, [...found.value.values()], viewerId);
};

moderationRoutes.get("/api/v2/filters/:id/statuses", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const row = await findFilterById(c.env.DB, user.value.id, c.req.param("id") ?? "");
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return filterNotFound(c);
  }
  const statusIds = await listFilterStatusIds(c.env.DB, row.value.id);
  if (statusIds.isErr()) {
    return jsonRepositoryError(c, statusIds.error.message);
  }
  return c.json(await filterStatusDocuments(c, statusIds.value));
});

moderationRoutes.post("/api/v2/filters/:id/statuses", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const row = await findFilterById(c.env.DB, user.value.id, c.req.param("id") ?? "");
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return filterNotFound(c);
  }
  const body = await readBody(c, FilterStatusesBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const added = await addFilterStatuses(c.env.DB, row.value.id, stringList(body.value.status_ids));
  if (added.isErr()) {
    return jsonRepositoryError(c, added.error.message);
  }
  return c.json({});
});

moderationRoutes.delete("/api/v2/filters/:id/statuses/:statusId", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const row = await findFilterById(c.env.DB, user.value.id, c.req.param("id") ?? "");
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return filterNotFound(c);
  }
  const removed = await removeFilterStatus(c.env.DB, row.value.id, c.req.param("statusId") ?? "");
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (!removed.value) {
    return filterNotFound(c);
  }
  return c.json({});
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
