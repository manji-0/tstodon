import type { InstanceIdentity } from "@tstodon/domain";
import { conversationDocuments } from "./conversation-documents";
import { listConversationsForAccount, type ConversationSummary } from "./conversation-store";
import { publishToHub } from "./stream-publish";

/**
 * Conversations checked per account for the one a new status ends up in. The
 * new status is the newest in its conversation, so it sits at the top of the
 * list unless a backfilled id sorts it lower.
 */
const CONVERSATION_WINDOW = 20;

/**
 * Conversations checked for one the account just marked read: the same window
 * `POST /api/v1/conversations/:id/read` finds it in.
 */
const READ_WINDOW = 100;

/**
 * Send each account in `accountIds` the conversation `matches` picks out of
 * its list within `window`, as `GET /api/v1/conversations` would now show it,
 * on its `direct` stream (Mastodon's `conversation` event). An account whose
 * list has no match hears nothing. Best effort: the change is stored either
 * way, and shows on the next list fetch.
 */
const publishConversation = async (
  env: Env,
  identity: InstanceIdentity,
  accountIds: ReadonlyArray<string>,
  window: number,
  matches: (conversation: ConversationSummary) => boolean,
): Promise<void> => {
  for (const accountId of new Set(accountIds)) {
    try {
      const conversations = await listConversationsForAccount(env.DB, identity, accountId, window);
      const conversation = conversations.isOk() ? conversations.value.find(matches) : undefined;
      if (!conversation) {
        continue;
      }
      const documents = await conversationDocuments(env, identity, accountId, [conversation]);
      if (documents.isErr()) {
        console.error(JSON.stringify({ kind: "ConversationNotPublished", accountId }));
        continue;
      }
      const [payload] = documents.value;
      if (!payload) {
        continue;
      }
      await publishToHub(env, accountId, {
        channels: [{ kind: "Direct" }],
        event: { kind: "conversation", payload },
      });
    } catch {
      console.error(JSON.stringify({ kind: "ConversationNotPublished", accountId }));
    }
  }
};

/**
 * Tell each account in `accountIds` about the conversation direct status
 * `statusId` joined or started. An account whose list does not carry the
 * status as its conversation's last one (the author is blocked or muted, the
 * account removed the conversation, or the status fell outside the list)
 * hears nothing.
 */
export const publishConversationUpdate = (
  env: Env,
  identity: InstanceIdentity,
  accountIds: ReadonlyArray<string>,
  statusId: string,
): Promise<void> =>
  publishConversation(
    env,
    identity,
    accountIds,
    CONVERSATION_WINDOW,
    (conversation) => conversation.lastStatus.status.id === statusId,
  );

/**
 * Tell `accountId`'s `direct` stream that it marked `conversationId` read,
 * with the entity as the list now shows it (`unread: false`). Mastodon does
 * the same when its `read` action updates the account conversation, and sends
 * nothing when a conversation is removed.
 */
export const publishConversationRead = (
  env: Env,
  identity: InstanceIdentity,
  accountId: string,
  conversationId: string,
): Promise<void> =>
  publishConversation(
    env,
    identity,
    [accountId],
    READ_WINDOW,
    (conversation) => conversation.id === conversationId,
  );
