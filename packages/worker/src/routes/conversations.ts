import type { Context } from "hono";
import { conversationDocuments } from "../conversation-documents";
import {
  hideConversation,
  latestStatusIdInConversation,
  listConversationsForAccount,
} from "../conversation-store";
import { publishConversationRead } from "../conversation-stream";
import { jsonAuthError, jsonRepositoryError, queryLimit, requireUser } from "../http";
import { markConversationRead } from "../marker-store";
import { parseInstanceIdentity } from "../runtime-config";

export const getV1Conversations = async (
  c: Context<{ Bindings: Env }, "/api/v1/conversations">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const conversations = await listConversationsForAccount(
    c.env.DB,
    identity.value,
    user.value.id,
    queryLimit(c.req.query("limit"), 20),
  );
  if (conversations.isErr()) {
    return jsonRepositoryError(c, conversations.error.message);
  }
  return c.json(
    await conversationDocuments(c.env, identity.value, user.value.id, conversations.value),
  );
};

export const postV1ConversationsByIdRead = async (
  c: Context<{ Bindings: Env }, "/api/v1/conversations/:id/read">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const conversationId = c.req.param("id");
  const latest = await latestStatusIdInConversation(
    c.env.DB,
    identity.value,
    user.value.id,
    conversationId,
  );
  if (latest.isErr()) {
    return jsonRepositoryError(c, latest.error.message);
  }
  if (!latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const marked = await markConversationRead(c.env.DB, user.value.id, conversationId, latest.value);
  if (marked.isErr()) {
    return jsonRepositoryError(c, marked.error.message);
  }
  await publishConversationRead(c.env, identity.value, user.value.id, conversationId);
  return c.body(null, 200);
};

export const deleteV1ConversationsById = async (
  c: Context<{ Bindings: Env }, "/api/v1/conversations/:id">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const conversationId = c.req.param("id");
  const latest = await latestStatusIdInConversation(
    c.env.DB,
    identity.value,
    user.value.id,
    conversationId,
  );
  if (latest.isErr()) {
    return jsonRepositoryError(c, latest.error.message);
  }
  if (!latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const hidden = await hideConversation(c.env.DB, user.value.id, conversationId, latest.value);
  if (hidden.isErr()) {
    return jsonRepositoryError(c, hidden.error.message);
  }
  return c.body(null, 200);
};
