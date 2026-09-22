import { Hono } from "hono";
import { findAccountById } from "../account-store";
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
import { mastodonAccountDocument, mastodonStatuses } from "../mastodon";
import { parseInstanceIdentity } from "../runtime-config";
import { stringList } from "../schemas";
import { z } from "zod";

export const listRoutes = new Hono<{ Bindings: Env }>();

const CreateListBodySchema = z.object({
  title: z.string().min(1),
  replies_policy: ListRepliesPolicySchema.optional(),
});

const UpdateListBodySchema = z.object({
  title: z.string().min(1).optional(),
  replies_policy: ListRepliesPolicySchema.optional(),
});

const ListAccountsBodySchema = z.object({
  account_ids: z.union([z.array(z.string()), z.string()]),
});

listRoutes.get("/api/v1/lists", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const lists = await listListsForAccount(c.env.DB, user.value.id);
  if (lists.isErr()) {
    return jsonRepositoryError(c, lists.error.message);
  }
  return c.json(lists.value.map(toMastodonList));
});

listRoutes.post("/api/v1/lists", async (c) => {
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
  });
  if (created.isErr()) {
    return jsonRepositoryError(c, created.error.message);
  }
  return c.json(toMastodonList(created.value));
});

listRoutes.get("/api/v1/lists/:id", async (c) => {
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
});

listRoutes.put("/api/v1/lists/:id", async (c) => {
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
  });
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }
  if (!updated.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(toMastodonList(updated.value));
});

listRoutes.delete("/api/v1/lists/:id", async (c) => {
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
});

listRoutes.get("/api/v1/lists/:id/accounts", async (c) => {
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
  const documents = [];
  for (const memberId of memberIds.value) {
    const account = await findAccountById(c.env.DB, memberId);
    if (account.isOk() && account.value) {
      documents.push(await mastodonAccountDocument(c.env, identity.value, account.value));
    }
  }
  return c.json(documents);
});

listRoutes.post("/api/v1/lists/:id/accounts", async (c) => {
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
  const existing: string[] = [];
  for (const accountId of accountIds) {
    const account = await findAccountById(c.env.DB, accountId);
    if (account.isOk() && account.value) {
      existing.push(account.value.id);
    }
  }
  const added = await addListMembers(c.env.DB, list.value.id, existing);
  if (added.isErr()) {
    return jsonRepositoryError(c, added.error.message);
  }
  return c.body(null, 200);
});

listRoutes.delete("/api/v1/lists/:id/accounts", async (c) => {
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
});

listRoutes.get("/api/v1/accounts/:id/lists", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const lists = await listListsContainingAccount(c.env.DB, user.value.id, c.req.param("id"));
  if (lists.isErr()) {
    return jsonRepositoryError(c, lists.error.message);
  }
  return c.json(lists.value.map(toMastodonList));
});

listRoutes.get("/api/v1/timelines/list/:id", async (c) => {
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
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, user.value.id));
});
