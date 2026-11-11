import { type ApiFilterJSON, ApiFilterParamsSchema } from "@tstodon/api";
import { type Context } from "hono";
import { warmSchemas } from "@tstodon/core";
import type { z } from "zod";
import { jsonAuthError, jsonRepositoryError, jsonValidationError, requireUser } from "../../http";
import { newEntityId } from "../../ids";
import { mastodonFilterV2 } from "../../filter-documents";
import {
  deleteFilter,
  type FilterKeyword,
  filterKeywords,
  type FilterRow,
  findFilterById,
  insertFilter,
  listAccountFilterStatuses,
  listFilters,
  listFilterStatuses,
  updateFilter,
} from "../../filter-store";
import { isTruthy } from "../../form-values";
import { readParams } from "../../request-params";
import { expiresAtFromBody, filterActionOf, filterNotFound, storedContexts } from "./shared";

export const postV2Filters = async (c: Context<{ Bindings: Env }, "/api/v2/filters">) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readParams(c, ApiFilterParamsSchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const keywords = keywordsFromBody(body.value);
  const title = (body.value.title ?? body.value.phrase ?? "").trim();
  const phrase = title.length > 0 ? title : (keywords[0]?.keyword ?? "");
  if (phrase.length === 0) {
    return c.json({ error: "title is required", kind: "ValidationError" }, 422);
  }
  const contexts = body.value.context ?? [];
  const created = await insertFilter(c.env.DB, {
    accountId: user.value.id,
    phrase,
    context: contexts.length > 0 ? contexts : ["home"],
    wholeWord: keywords[0]?.whole_word ?? false,
    irreversible:
      body.value.filter_action !== undefined
        ? filterActionOf(body.value.filter_action) === "hide"
        : (body.value.irreversible ?? false),
    expiresAt: expiresAtFromBody(body.value.expires_in) ?? undefined,
    keywords,
  });
  if (created.isErr()) {
    return jsonRepositoryError(c, created.error.message);
  }
  return c.json(mastodonFilterV2(created.value), 200);
};

export const getV2Filters = async (c: Context<{ Bindings: Env }, "/api/v2/filters">) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const [rows, statuses] = await Promise.all([
    listFilters(c.env.DB, user.value.id),
    listAccountFilterStatuses(c.env.DB, user.value.id),
  ]);
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  const statusesByFilter = statuses.isOk() ? statuses.value : undefined;
  return c.json(
    rows.value.map((row): ApiFilterJSON =>
      mastodonFilterV2(row, statusesByFilter?.get(row.id) ?? []),
    ),
  );
};

/** Keywords from either `keywords_attributes[]` or `keywords[]`, in order. */
const keywordsFromBody = (body: z.output<typeof ApiFilterParamsSchema>): FilterKeyword[] => {
  const entries = [
    ...(body.keywords_attributes ?? []).filter((entry) => !isTruthy(entry._destroy)),
    ...(body.keywords ?? []).map((entry) =>
      typeof entry === "string" ? { keyword: entry } : entry,
    ),
  ];
  return entries.flatMap((entry): FilterKeyword[] => {
    const keyword = entry.keyword?.trim() ?? "";
    return keyword.length === 0
      ? []
      : [
          {
            id: entry.id && entry.id.length > 0 ? entry.id : newEntityId(),
            keyword,
            whole_word: entry.whole_word !== undefined ? isTruthy(entry.whole_word) : false,
          },
        ];
  });
};

/** The v2 Filter document, with the FilterStatus entries it is narrowed to. */
const filterDocumentV2 = async (
  c: Context<{ Bindings: Env }>,
  row: FilterRow,
): Promise<ApiFilterJSON> => {
  const statuses = await listFilterStatuses(c.env.DB, row.id);
  return mastodonFilterV2(row, statuses.isOk() ? statuses.value : []);
};

export const getV2FiltersById = async (c: Context<{ Bindings: Env }, "/api/v2/filters/:id">) => {
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
};

export const putV2FiltersById = async (c: Context<{ Bindings: Env }, "/api/v2/filters/:id">) => {
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
  const body = await readParams(c, ApiFilterParamsSchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  // Omitted keywords keep whatever the filter already had.
  const keywordsProvided =
    body.value.keywords !== undefined || body.value.keywords_attributes !== undefined;
  const keywords = keywordsProvided ? keywordsFromBody(body.value) : filterKeywords(existing.value);
  const title = (body.value.title ?? body.value.phrase ?? "").trim();
  const phrase = title.length > 0 ? title : (keywords[0]?.keyword ?? existing.value.phrase);
  const contexts = body.value.context ?? [];
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
};

export const deleteV2FiltersById = async (c: Context<{ Bindings: Env }, "/api/v2/filters/:id">) => {
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
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([ApiFilterParamsSchema]);
