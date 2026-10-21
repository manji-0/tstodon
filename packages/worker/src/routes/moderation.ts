import { type Context, Hono } from "hono";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { z } from "zod";
import { parseJsonColumn } from "../json-column";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readBody,
  requireUser,
} from "../http";
import { newEntityId } from "../ids";
import { mastodonFilter, mastodonFilterV2 } from "../filter-documents";
import { instanceRules } from "../runtime-config";
import {
  addFilterStatus,
  deleteFilter,
  type FilterKeyword,
  filterKeywords,
  type FilterRow,
  findFilterById,
  findFilterStatusById,
  insertFilter,
  insertReport,
  listFilters,
  listFilterStatuses,
  removeFilterStatusById,
  ReportCategorySchema,
  updateFilter,
} from "../moderation-store";
import { isTruthy, stringList } from "../form-values";
import { booleanish } from "../form-values";

export const FilterBodySchema = z.object({
  phrase: z.string().trim().min(1),
  context: z.union([z.array(z.string()), z.string()]).optional(),
  whole_word: booleanish,
  irreversible: booleanish,
  expires_in: z.union([z.number(), z.string()]).optional(),
});

export const FilterV2BodySchema = z.object({
  title: z.string().optional(),
  phrase: z.string().optional(),
  context: z.union([z.array(z.string()), z.string()]).optional(),
  filter_action: z.string().optional(),
  irreversible: booleanish,
  expires_in: z.union([z.number(), z.string()]).optional(),
  keywords_attributes: z
    .array(
      z.object({
        id: z.string().optional(),
        keyword: z.string().optional(),
        whole_word: booleanish,
        _destroy: booleanish,
      }),
    )
    .optional(),
  keywords: z
    .array(
      z.union([
        z.string(),
        z.object({
          id: z.string().optional(),
          keyword: z.string().optional(),
          whole_word: booleanish,
        }),
      ]),
    )
    .optional(),
});

export const FilterKeywordBodySchema = z.object({
  keyword: z.string().optional(),
  whole_word: booleanish,
});

export const FilterStatusBodySchema = z.object({
  status_id: z.string().trim().min(1),
});

export const ReportBodySchema = z.object({
  account_id: z.string().min(1),
  status_ids: z.union([z.array(z.string()), z.string()]).optional(),
  comment: z.string().optional(),
  category: z.string().optional(),
  rule_ids: z
    .union([z.array(z.union([z.string(), z.number()])), z.string(), z.number()])
    .optional(),
});

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

moderationRoutes.get("/api/v1/filters/:id", async (c) => {
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
  return c.json(mastodonFilter(row.value));
});

/** v1 update: the phrase replaces the filter's first keyword, the rest keep. */
moderationRoutes.put("/api/v1/filters/:id", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const id = c.req.param("id");
  const existing = await findFilterById(c.env.DB, user.value.id, id);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (!existing.value) {
    return filterNotFound(c);
  }
  const body = await readBody(c, FilterBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const phrase = body.value.phrase.trim();
  const wholeWord =
    body.value.whole_word === undefined
      ? existing.value.whole_word === 1
      : isTruthy(body.value.whole_word);
  const [first, ...rest] = filterKeywords(existing.value);
  const contexts = stringList(body.value.context);
  const updated = await updateFilter(c.env.DB, user.value.id, id, {
    phrase,
    context: contexts.length > 0 ? contexts : storedContexts(existing.value),
    wholeWord,
    irreversible:
      body.value.irreversible === undefined
        ? existing.value.irreversible === 1
        : isTruthy(body.value.irreversible),
    expiresAt:
      body.value.expires_in === undefined
        ? existing.value.expires_at
        : expiresAtFromBody(body.value.expires_in),
    keywords: [{ id: first?.id ?? newEntityId(), keyword: phrase, whole_word: wholeWord }, ...rest],
  });
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }
  const row = await findFilterById(c.env.DB, user.value.id, id);
  if (row.isErr() || !row.value) {
    return filterNotFound(c);
  }
  return c.json(mastodonFilter(row.value));
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

/**
 * Mastodon's `filter_action`: `hide` is the only action tstodon stores, and
 * anything else (an absent value, or `blur`, which belongs to API version 5)
 * falls back to `warn`, which is what the entity documents for unknown values.
 */
const filterActionOf = (value: unknown): "warn" | "hide" => (value === "hide" ? "hide" : "warn");

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
        ? filterActionOf(body.value.filter_action) === "hide"
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
    documents.push(await filterDocumentV2(c, row));
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

const storedContexts = (row: Pick<FilterRow, "context_json">): string[] =>
  parseJsonColumn(z.array(z.string()), row.context_json).unwrapOr([]);

/** The v2 Filter document, with the FilterStatus entries it is narrowed to. */
const filterDocumentV2 = async (
  c: Context<{ Bindings: Env }>,
  row: FilterRow,
): Promise<Record<string, unknown>> => {
  const statuses = await listFilterStatuses(c.env.DB, row.id);
  return mastodonFilterV2(row, statuses.isOk() ? statuses.value : []);
};

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
  return c.json(await filterDocumentV2(c, row.value));
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
    context: contexts.length > 0 ? contexts : storedContexts(existing.value),
    wholeWord: keywords[0]?.whole_word ?? existing.value.whole_word === 1,
    irreversible:
      action === undefined ? existing.value.irreversible === 1 : filterActionOf(action) === "hide",
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
  return c.json(await filterDocumentV2(c, row.value));
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

/** Store a filter's keywords; the first one stands in as the v1 phrase. */
const writeKeywords = (
  db: D1Database,
  accountId: string,
  row: FilterRow,
  keywords: ReadonlyArray<FilterKeyword>,
) =>
  updateFilter(db, accountId, row.id, {
    phrase: keywords[0]?.keyword ?? row.phrase,
    context: storedContexts(row),
    wholeWord: keywords[0]?.whole_word ?? row.whole_word === 1,
    irreversible: row.irreversible === 1,
    expiresAt: row.expires_at,
    keywords,
  });

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
  const written = await writeKeywords(c.env.DB, user.value.id, row.value, [...existing, appended]);
  if (written.isErr()) {
    return jsonRepositoryError(c, written.error.message);
  }
  return c.json(appended);
});

/** The viewer's filter holding keyword `keywordId`, with its keywords. */
const findKeyword = async (
  db: D1Database,
  accountId: string,
  keywordId: string,
): Promise<
  | Readonly<{ kind: "Found"; row: FilterRow; keywords: ReadonlyArray<FilterKeyword> }>
  | Readonly<{ kind: "NotFound" }>
  | Readonly<{ kind: "Failed"; message: string }>
> => {
  const rows = await listFilters(db, accountId);
  if (rows.isErr()) {
    return { kind: "Failed", message: rows.error.message };
  }
  for (const row of rows.value) {
    const keywords = filterKeywords(row);
    if (keywords.some((entry) => entry.id === keywordId)) {
      return { kind: "Found", row, keywords };
    }
  }
  return { kind: "NotFound" };
};

moderationRoutes.get("/api/v2/filters/keywords/:id", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const keywordId = c.req.param("id");
  const found = await findKeyword(c.env.DB, user.value.id, keywordId);
  if (found.kind === "Failed") {
    return jsonRepositoryError(c, found.message);
  }
  const keyword =
    found.kind === "Found" ? found.keywords.find((entry) => entry.id === keywordId) : undefined;
  return keyword ? c.json(keyword) : filterNotFound(c);
});

moderationRoutes.put("/api/v2/filters/keywords/:id", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const keywordId = c.req.param("id");
  const found = await findKeyword(c.env.DB, user.value.id, keywordId);
  if (found.kind === "Failed") {
    return jsonRepositoryError(c, found.message);
  }
  const current =
    found.kind === "Found" ? found.keywords.find((entry) => entry.id === keywordId) : undefined;
  if (found.kind !== "Found" || !current) {
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
  const written = await writeKeywords(
    c.env.DB,
    user.value.id,
    found.row,
    found.keywords.map((entry) => (entry.id === keywordId ? next : entry)),
  );
  if (written.isErr()) {
    return jsonRepositoryError(c, written.error.message);
  }
  return c.json(next);
});

moderationRoutes.delete("/api/v2/filters/keywords/:id", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const keywordId = c.req.param("id");
  const found = await findKeyword(c.env.DB, user.value.id, keywordId);
  if (found.kind === "Failed") {
    return jsonRepositoryError(c, found.message);
  }
  if (found.kind === "NotFound") {
    return filterNotFound(c);
  }
  const remaining = found.keywords.filter((entry) => entry.id !== keywordId);
  if (remaining.length === 0) {
    return c.json({ error: "a filter needs at least one keyword", kind: "ValidationError" }, 422);
  }
  const written = await writeKeywords(c.env.DB, user.value.id, found.row, remaining);
  if (written.isErr()) {
    return jsonRepositoryError(c, written.error.message);
  }
  return c.json({});
});

moderationRoutes.get("/api/v2/filters/statuses/:id", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const found = await findFilterStatusById(c.env.DB, user.value.id, c.req.param("id"));
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  return found.value ? c.json(found.value) : filterNotFound(c);
});

moderationRoutes.delete("/api/v2/filters/statuses/:id", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const removed = await removeFilterStatusById(c.env.DB, user.value.id, c.req.param("id"));
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  return removed.value ? c.json({}) : filterNotFound(c);
});

moderationRoutes.get("/api/v2/filters/:id/statuses", async (c) => {
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
  const statuses = await listFilterStatuses(c.env.DB, row.value.id);
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  return c.json(statuses.value);
});

/** Narrow a filter to `status_id`; adding the same status again answers the same entry. */
moderationRoutes.post("/api/v2/filters/:id/statuses", async (c) => {
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
  const body = await readBody(c, FilterStatusBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const added = await addFilterStatus(c.env.DB, row.value.id, body.value.status_id);
  if (added.isErr()) {
    return jsonRepositoryError(c, added.error.message);
  }
  return added.value ? c.json(added.value) : filterNotFound(c);
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
  const requestedCategory = (body.value.category ?? "other").trim().toLowerCase();
  const category = schemaResult(ReportCategorySchema)(requestedCategory);
  if (category.isErr()) {
    return c.json(
      { error: "Validation failed: Category is not included in the list", kind: "ValidationError" },
      422,
    );
  }
  // Rule ids are the configured `INSTANCE_RULES` entries, and Mastodon keeps
  // them for `violation` reports only.
  const rawRuleIds = body.value.rule_ids;
  const requestedRules = (
    Array.isArray(rawRuleIds)
      ? rawRuleIds.map((value) => String(value).trim())
      : typeof rawRuleIds === "string" || typeof rawRuleIds === "number"
        ? [String(rawRuleIds).trim()]
        : []
  ).filter((value) => value.length > 0);
  const knownRules = new Set(instanceRules(c.env).map((rule) => rule.id));
  if (requestedRules.length > 0 && category.value !== "violation") {
    return c.json(
      { error: "Validation failed: Rule ids must be blank", kind: "ValidationError" },
      422,
    );
  }
  if (requestedRules.some((id) => !knownRules.has(id))) {
    return c.json(
      { error: "Validation failed: Rule ids are invalid", kind: "ValidationError" },
      422,
    );
  }
  const report = await insertReport(c.env.DB, {
    accountId: user.value.id,
    targetAccountId: body.value.account_id,
    statusIds: stringList(body.value.status_ids),
    comment: body.value.comment ?? "",
    category: category.value,
    ruleIds: requestedRules,
  });
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  return c.json({
    id: report.value.id,
    action_taken: false,
    action_taken_at: null,
    category: category.value,
    comment: body.value.comment ?? "",
    forwarded: false,
    status_ids: stringList(body.value.status_ids),
    rule_ids: requestedRules,
    target_account: { id: body.value.account_id },
  });
});

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([
  FilterBodySchema,
  FilterV2BodySchema,
  FilterKeywordBodySchema,
  FilterStatusBodySchema,
  ReportBodySchema,
]);
