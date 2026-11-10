import type { Context } from "hono";
import { findAccountsByIds } from "../account-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryLimit,
  requireUser,
} from "../http";
import {
  addListMembers,
  createList,
  deleteList,
  findListForAccount,
  findUnfollowedMember,
  ListMember,
  listListMembers,
  listListsContainingMember,
  listListsForAccount,
  removeListMembers,
  toMastodonList,
  updateList,
} from "../list-store";
import { availableAccountDocumentsByIds, documentsInOrder } from "../account-documents";
import { writeTimelineMetric } from "../metrics";
import { parseInstanceIdentity } from "../runtime-config";
import { listTimelineDocuments } from "../timeline-documents";
import { paramsCursor, readMergedParams, readParams, readQueryParams } from "../request-params";
import { warmSchemas } from "@tstodon/core";
import {
  ApiCreateListParamsSchema,
  ApiGetListTimelineParamsSchema,
  ApiListAccountsParamsSchema,
  ApiUpdateListParamsSchema,
} from "@tstodon/api";

warmSchemas([
  ApiCreateListParamsSchema,
  ApiUpdateListParamsSchema,
  ApiListAccountsParamsSchema,
  ApiGetListTimelineParamsSchema,
]);

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
  const body = await readParams(c, ApiCreateListParamsSchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const created = await createList(c.env.DB, user.value.id, {
    title: body.value.title.trim(),
    ...(body.value.replies_policy ? { repliesPolicy: body.value.replies_policy } : {}),
    ...(body.value.exclusive !== undefined ? { exclusive: body.value.exclusive } : {}),
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
  const body = await readParams(c, ApiUpdateListParamsSchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const updated = await updateList(c.env.DB, user.value.id, c.req.param("id"), {
    ...(body.value.title ? { title: body.value.title } : {}),
    ...(body.value.replies_policy ? { repliesPolicy: body.value.replies_policy } : {}),
    ...(body.value.exclusive !== undefined ? { exclusive: body.value.exclusive } : {}),
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
  return c.json({});
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
  const members = await listListMembers(c.env.DB, list.value.id);
  if (members.isErr()) {
    return jsonRepositoryError(c, members.error.message);
  }
  const memberIds = members.value.map(ListMember.accountId);
  const byId = await availableAccountDocumentsByIds(c.env, identity.value, memberIds);
  if (byId.isErr()) {
    return jsonRepositoryError(c, byId.error.message);
  }
  return c.json(documentsInOrder(memberIds, byId.value));
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
  const body = await readParams(c, ApiListAccountsParamsSchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const members = body.value.account_ids.map(ListMember.fromAccountId);
  const found = await findAccountsByIds(
    c.env.DB,
    members.flatMap((member) => (member.kind === "LocalAccount" ? [member.accountId] : [])),
  );
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  const existing = members.filter(
    (member) => member.kind === "RemoteActor" || found.value.has(member.accountId),
  );
  // As in Mastodon, an account goes on a list only while it is followed, and
  // one that is not refuses the whole request.
  const unfollowed = await findUnfollowedMember(c.env.DB, user.value.id, existing);
  if (unfollowed.isErr()) {
    return jsonRepositoryError(c, unfollowed.error.message);
  }
  if (unfollowed.value) {
    return c.json(
      { error: "Validation failed: Account must be a followed account", kind: "NotFollowed" },
      422,
    );
  }
  const added = await addListMembers(c.env.DB, list.value.id, existing);
  if (added.isErr()) {
    return jsonRepositoryError(c, added.error.message);
  }
  return c.json({});
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
  // The web UI sends these in the query, as Mastodon allows.
  const body = await readMergedParams(c, ApiListAccountsParamsSchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const removed = await removeListMembers(
    c.env.DB,
    list.value.id,
    body.value.account_ids.map(ListMember.fromAccountId),
  );
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  return c.json({});
};

export const getV1AccountsByIdLists = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/lists">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const lists = await listListsContainingMember(
    c.env.DB,
    user.value.id,
    ListMember.fromAccountId(c.req.param("id")),
  );
  if (lists.isErr()) {
    return jsonRepositoryError(c, lists.error.message);
  }
  return c.json(lists.value.map(toMastodonList));
};

export const getV1TimelinesListById = async (
  c: Context<{ Bindings: Env }, "/api/v1/timelines/list/:id">,
) => {
  const startedAt = Date.now();
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const params = readQueryParams(c, ApiGetListTimelineParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const list = await findListForAccount(c.env.DB, user.value.id, c.req.param("id"));
  if (list.isErr()) {
    return jsonRepositoryError(c, list.error.message);
  }
  if (!list.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const documents = await listTimelineDocuments(
    c.env,
    identity.value,
    user.value.id,
    list.value,
    queryLimit(params.value.limit),
    paramsCursor(params.value),
  );
  writeTimelineMetric(
    c.env,
    "list",
    startedAt,
    documents.isOk() ? documents.value.length : undefined,
  );
  if (documents.isErr()) {
    return jsonRepositoryError(c, documents.error.message);
  }
  return c.json(documents.value);
};
