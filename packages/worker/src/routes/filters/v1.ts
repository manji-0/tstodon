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
import { mastodonFilter } from "../../filter-documents";
import {
  deleteFilter,
  filterKeywords,
  findFilterById,
  insertFilter,
  listFilters,
  updateFilter,
} from "../../filter-store";
import { isTruthy, stringList } from "../../form-values";
import { booleanish } from "../../form-values";
import { expiresAtFromBody, filterNotFound, storedContexts } from "./shared";

export const filterV1Routes = new Hono<{ Bindings: Env }>();

export const FilterBodySchema = z.object({
  phrase: z.string().trim().min(1),
  context: z.union([z.array(z.string()), z.string()]).optional(),
  whole_word: booleanish,
  irreversible: booleanish,
  expires_in: z.union([z.number(), z.string()]).optional(),
});

filterV1Routes.get("/api/v1/filters", async (c) => {
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

filterV1Routes.post("/api/v1/filters", async (c) => {
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

filterV1Routes.get("/api/v1/filters/:id", async (c) => {
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
filterV1Routes.put("/api/v1/filters/:id", async (c) => {
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

filterV1Routes.delete("/api/v1/filters/:id", async (c) => {
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

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([FilterBodySchema]);
