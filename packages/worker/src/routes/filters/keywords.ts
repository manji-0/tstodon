import { Hono } from "hono";
import { warmSchemas } from "@tstodon/core";
import { z } from "zod";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readBody,
  requireUser,
} from "../../http";
import { newEntityId } from "../../ids";
import {
  type FilterKeyword,
  filterKeywords,
  type FilterRow,
  findFilterById,
  listFilters,
  updateFilter,
} from "../../filter-store";
import { isTruthy } from "../../form-values";
import { booleanish } from "../../form-values";
import { filterNotFound, storedContexts } from "./shared";

export const filterKeywordRoutes = new Hono<{ Bindings: Env }>();

export const FilterKeywordBodySchema = z.object({
  keyword: z.string().optional(),
  whole_word: booleanish,
});

filterKeywordRoutes.get("/api/v2/filters/:id/keywords", async (c) => {
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

filterKeywordRoutes.post("/api/v2/filters/:id/keywords", async (c) => {
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

filterKeywordRoutes.get("/api/v2/filters/keywords/:id", async (c) => {
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

filterKeywordRoutes.put("/api/v2/filters/keywords/:id", async (c) => {
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

filterKeywordRoutes.delete("/api/v2/filters/keywords/:id", async (c) => {
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

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([FilterKeywordBodySchema]);
