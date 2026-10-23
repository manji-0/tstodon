import type { Context } from "hono";
import { warmSchemas } from "@tstodon/core";
import { z } from "zod";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readBody,
  requireUser,
} from "../../http";
import {
  addFilterStatus,
  findFilterById,
  findFilterStatusById,
  listFilterStatuses,
  removeFilterStatusById,
} from "../../filter-store";
import { filterNotFound } from "./shared";

export const FilterStatusBodySchema = z.object({
  status_id: z.string().trim().min(1),
});

export const getV2FiltersStatusesById = async (
  c: Context<{ Bindings: Env }, "/api/v2/filters/statuses/:id">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const found = await findFilterStatusById(c.env.DB, user.value.id, c.req.param("id"));
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  return found.value ? c.json(found.value) : filterNotFound(c);
};

export const deleteV2FiltersStatusesById = async (
  c: Context<{ Bindings: Env }, "/api/v2/filters/statuses/:id">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const removed = await removeFilterStatusById(c.env.DB, user.value.id, c.req.param("id"));
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  return removed.value ? c.json({}) : filterNotFound(c);
};

export const getV2FiltersByIdStatuses = async (
  c: Context<{ Bindings: Env }, "/api/v2/filters/:id/statuses">,
) => {
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
};

/** Narrow a filter to `status_id`; adding the same status again answers the same entry. */
export const postV2FiltersByIdStatuses = async (
  c: Context<{ Bindings: Env }, "/api/v2/filters/:id/statuses">,
) => {
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
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([FilterStatusBodySchema]);
