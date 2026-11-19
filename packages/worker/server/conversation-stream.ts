import type { InstanceIdentity } from "@tstodon/domain";
import { conversationDocuments } from "./conversation-documents";
import { listConversationsForAccount, type ConversationSummary } from "./conversation-store";
import { publishToHub } from "./stream-publish";
import { listHubStreamSubscriptions } from "./stream-subscription-store";

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
 * Send each account in `accountIds` the conversations `matches` picks out of
 * its list within `window`, as `GET /api/v1/conversations` would now show them,
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
  // A hub drops an event for a stream it does not hold, so only accounts with
  // a `direct` stream open are rendered for.
  const subscriptions = await listHubStreamSubscriptions(
    env.DB,
    [...new Set(accountIds)],
    ["direct"],
  );
  if (subscriptions.isErr()) {
    console.error(JSON.stringify({ kind: "ConversationNotPublished" }));
    return;
  }
  const listening = new Set(subscriptions.value.map(({ hub }) => hub));
  for (const accountId of new Set(accountIds.filter((id) => listening.has(id)))) {
    try {
      const conversations = await listConversationsForAccount(env.DB, identity, accountId, {
        limit: window,
      });
      const matched = conversations.isOk() ? conversations.value.filter(matches) : [];
      if (matched.length === 0) {
        continue;
      }
      const documents = await conversationDocuments(env, identity, accountId, matched);
      if (documents.isErr()) {
        console.error(JSON.stringify({ kind: "ConversationNotPublished", accountId }));
        continue;
      }
      for (const payload of documents.value) {
        await publishToHub(env, accountId, {
          channels: [{ kind: "Direct" }],
          event: { kind: "conversation", payload },
        });
      }
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
 * Tell `accountId` about each conversation that one of `statusIds` now ends,
 * as Mastodon's `AccountConversation.add_status` streams each conversation
 * an accepted notification request adds a direct message to.
 */
export const publishConversationsJoined = (
  env: Env,
  identity: InstanceIdentity,
  accountId: string,
  statusIds: ReadonlyArray<string>,
): Promise<void> => {
  const joined = new Set(statusIds);
  return publishConversation(env, identity, [accountId], CONVERSATION_WINDOW, (conversation) =>
    joined.has(conversation.lastStatus.status.id),
  );
};

/**
 * Tell `accountId`'s `direct` stream that it marked `conversationId` read or
 * unread, with the entity as the list now shows it. Mastodon does the same
 * when its `read` or `unread` action updates the account conversation, and
 * sends nothing when a conversation is removed.
 */
export const publishConversationMarked = (
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
