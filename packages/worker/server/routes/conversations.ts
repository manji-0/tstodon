import type { Context } from "hono";
import { ApiGetConversationsParamsSchema } from "@tstodon/api";
import { warmSchemas } from "@tstodon/core";
import { conversationDocuments } from "../conversation-documents";
import {
  hideConversation,
  latestStatusIdInConversation,
  listConversationsForAccount,
} from "../conversation-store";
import { publishConversationRead } from "../conversation-stream";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryLimit,
  requireUser,
} from "../http";
import { markConversationRead } from "../marker-store";
import { readQueryParams } from "../request-params";
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
  // The paging cursor is not read yet: the list is always the latest page.
  const params = readQueryParams(c, ApiGetConversationsParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const conversations = await listConversationsForAccount(
    c.env.DB,
    identity.value,
    user.value.id,
    queryLimit(params.value.limit, 20),
  );
  if (conversations.isErr()) {
    return jsonRepositoryError(c, conversations.error.message);
  }
  const documents = await conversationDocuments(
    c.env,
    identity.value,
    user.value.id,
    conversations.value,
  );
  return documents.isErr()
    ? jsonRepositoryError(c, documents.error.message)
    : c.json(documents.value);
};

/** How far down the list a conversation just marked read is looked for (as its stream event). */
const READ_CONVERSATION_WINDOW = 100;

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
  // Mastodon answers with the conversation, now read, as the list shows it.
  const listed = await listConversationsForAccount(
    c.env.DB,
    identity.value,
    user.value.id,
    READ_CONVERSATION_WINDOW,
  );
  if (listed.isErr()) {
    return jsonRepositoryError(c, listed.error.message);
  }
  const conversation = listed.value.find((entry) => entry.id === conversationId);
  if (!conversation) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const documents = await conversationDocuments(c.env, identity.value, user.value.id, [
    conversation,
  ]);
  if (documents.isErr()) {
    return jsonRepositoryError(c, documents.error.message);
  }
  const [document] = documents.value;
  return document ? c.json(document) : c.json({ error: "Record not found", kind: "NotFound" }, 404);
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
  return c.json({});
};

warmSchemas([ApiGetConversationsParamsSchema]);
