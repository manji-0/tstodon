import type { Context } from "hono";
import { accountDocumentsByIds } from "../account-documents";
import { statusDocumentsByIds } from "../status-documents";
import {
  hideConversation,
  latestStatusIdInConversation,
  listConversationsForAccount,
} from "../conversation-store";
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
  // Participants may be remote (`r_…`), and a last status may be a cached
  // remote note; both render in bulk.
  const [accounts, statuses] = await Promise.all([
    accountDocumentsByIds(
      c.env,
      identity.value,
      conversations.value.flatMap((conversation) => conversation.accountIds),
    ),
    statusDocumentsByIds(
      c.env,
      identity.value,
      conversations.value.map((conversation) => conversation.lastStatus.status.id),
      user.value.id,
    ),
  ]);
  return c.json(
    conversations.value.map((conversation) => ({
      id: conversation.id,
      unread: conversation.unread,
      accounts: conversation.accountIds.flatMap((id) => accounts.get(id) ?? []),
      last_status: statuses.get(conversation.lastStatus.status.id) ?? null,
    })),
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
