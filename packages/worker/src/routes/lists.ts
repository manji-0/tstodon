import type { Context } from "hono";
import { findAccountsByIds } from "../account-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryLimit,
  readBody,
  requireUser,
} from "../http";
import {
  addListMembers,
  createList,
  deleteList,
  findListForAccount,
  ListRepliesPolicySchema,
  listListMemberIds,
  listListsContainingAccount,
  listListsForAccount,
  listListTimelineStatuses,
  removeListMembers,
  toMastodonList,
  updateList,
} from "../list-store";
import { accountDocumentsByIds, documentsInOrder } from "../account-documents";
import { mastodonStatuses } from "../local-status-documents";
import { parseInstanceIdentity } from "../runtime-config";
import { attachFilteredToStatuses } from "../filter-match";
import { filterMutedThreads } from "../status-mute-store";
import { isTruthy, stringList } from "../form-values";
import { warmSchemas } from "@tstodon/core";
import { z } from "zod";

const booleanish = z.union([z.boolean(), z.string(), z.number()]).optional();

const CreateListBodySchema = z.object({
  title: z.string().min(1),
  replies_policy: ListRepliesPolicySchema.optional(),
  exclusive: booleanish,
});

const UpdateListBodySchema = z.object({
  title: z.string().min(1).optional(),
  replies_policy: ListRepliesPolicySchema.optional(),
  exclusive: booleanish,
});

const ListAccountsBodySchema = z.object({
  account_ids: z.union([z.array(z.string()), z.string()]),
});

warmSchemas([CreateListBodySchema, UpdateListBodySchema, ListAccountsBodySchema]);

export const getV1Lists = async (c: Context<{ Bindings: Env }, "/api/v1/lists">) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const lists = await listListsForAccount(c.env.DB, user.value.id);
  if (lists.isErr()) {
    return jsonRepositoryError(c, lists.error.message);
  }
  return c.json(lists.value.map(toMastodonList));
};

export const postV1Lists = async (c: Context<{ Bindings: Env }, "/api/v1/lists">) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readBody(c, CreateListBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const created = await createList(c.env.DB, user.value.id, {
    title: body.value.title.trim(),
    ...(body.value.replies_policy ? { repliesPolicy: body.value.replies_policy } : {}),
    ...(body.value.exclusive !== undefined ? { exclusive: isTruthy(body.value.exclusive) } : {}),
  });
  if (created.isErr()) {
    return jsonRepositoryError(c, created.error.message);
  }
  return c.json(toMastodonList(created.value));
};

export const getV1ListsById = async (c: Context<{ Bindings: Env }, "/api/v1/lists/:id">) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const list = await findListForAccount(c.env.DB, user.value.id, c.req.param("id"));
  if (list.isErr()) {
    return jsonRepositoryError(c, list.error.message);
  }
  if (!list.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(toMastodonList(list.value));
};

export const putV1ListsById = async (c: Context<{ Bindings: Env }, "/api/v1/lists/:id">) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readBody(c, UpdateListBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const updated = await updateList(c.env.DB, user.value.id, c.req.param("id"), {
    ...(body.value.title ? { title: body.value.title } : {}),
    ...(body.value.replies_policy ? { repliesPolicy: body.value.replies_policy } : {}),
    ...(body.value.exclusive !== undefined ? { exclusive: isTruthy(body.value.exclusive) } : {}),
  });
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }
  if (!updated.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(toMastodonList(updated.value));
};

export const deleteV1ListsById = async (c: Context<{ Bindings: Env }, "/api/v1/lists/:id">) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const deleted = await deleteList(c.env.DB, user.value.id, c.req.param("id"));
  if (deleted.isErr()) {
    return jsonRepositoryError(c, deleted.error.message);
  }
  if (!deleted.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.body(null, 200);
};

export const getV1ListsByIdAccounts = async (
  c: Context<{ Bindings: Env }, "/api/v1/lists/:id/accounts">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const list = await findListForAccount(c.env.DB, user.value.id, c.req.param("id"));
  if (list.isErr()) {
    return jsonRepositoryError(c, list.error.message);
  }
  if (!list.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const memberIds = await listListMemberIds(c.env.DB, list.value.id);
  if (memberIds.isErr()) {
    return jsonRepositoryError(c, memberIds.error.message);
  }
  const byId = await accountDocumentsByIds(c.env, identity.value, memberIds.value);
  return c.json(documentsInOrder(memberIds.value, byId));
};

export const postV1ListsByIdAccounts = async (
  c: Context<{ Bindings: Env }, "/api/v1/lists/:id/accounts">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const list = await findListForAccount(c.env.DB, user.value.id, c.req.param("id"));
  if (list.isErr()) {
    return jsonRepositoryError(c, list.error.message);
  }
  if (!list.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const body = await readBody(c, ListAccountsBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const accountIds = stringList(body.value.account_ids);
  const found = await findAccountsByIds(c.env.DB, accountIds);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  const existing = accountIds.filter((accountId) => found.value.has(accountId));
  const added = await addListMembers(c.env.DB, list.value.id, existing);
  if (added.isErr()) {
    return jsonRepositoryError(c, added.error.message);
  }
  return c.body(null, 200);
};

export const deleteV1ListsByIdAccounts = async (
  c: Context<{ Bindings: Env }, "/api/v1/lists/:id/accounts">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const list = await findListForAccount(c.env.DB, user.value.id, c.req.param("id"));
  if (list.isErr()) {
    return jsonRepositoryError(c, list.error.message);
  }
  if (!list.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const body = await readBody(c, ListAccountsBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const removed = await removeListMembers(
    c.env.DB,
    list.value.id,
    stringList(body.value.account_ids),
  );
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  return c.body(null, 200);
};

export const getV1AccountsByIdLists = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/lists">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const lists = await listListsContainingAccount(c.env.DB, user.value.id, c.req.param("id"));
  if (lists.isErr()) {
    return jsonRepositoryError(c, lists.error.message);
  }
  return c.json(lists.value.map(toMastodonList));
};

export const getV1TimelinesListById = async (
  c: Context<{ Bindings: Env }, "/api/v1/timelines/list/:id">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const list = await findListForAccount(c.env.DB, user.value.id, c.req.param("id"));
  if (list.isErr()) {
    return jsonRepositoryError(c, list.error.message);
  }
  if (!list.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const statuses = await listListTimelineStatuses(c.env.DB, {
    listId: list.value.id,
    ownerAccountId: user.value.id,
    repliesPolicy: list.value.repliesPolicy,
    limit: queryLimit(c.req.query("limit")),
    maxId: c.req.query("max_id"),
  });
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const visible = await filterMutedThreads(c.env.DB, user.value.id, statuses.value);
  if (visible.isErr()) {
    return jsonRepositoryError(c, visible.error.message);
  }
  return c.json(
    await attachFilteredToStatuses(
      c.env.DB,
      user.value.id,
      "home",
      visible.value,
      await mastodonStatuses(c.env, identity.value, visible.value, user.value.id),
    ),
  );
};
