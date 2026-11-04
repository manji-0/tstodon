import type { InstanceIdentity } from "@tstodon/domain";
import { conversationDocuments } from "./conversation-documents";
import { listConversationsForAccount } from "./conversation-store";
import { publishToHub } from "./stream-publish";

/**
 * Conversations checked per account for the one a new status ends up in. The
 * new status is the newest in its conversation, so it sits at the top of the
 * list unless a backfilled id sorts it lower.
 */
const CONVERSATION_WINDOW = 20;

/**
 * Tell each account in `accountIds` about the conversation direct status
 * `statusId` joined or started, as `GET /api/v1/conversations` would now show
 * it to them, on their `direct` stream (Mastodon's `conversation` event). An
 * account whose list does not carry the status as its conversation's last one
 * (the author is blocked or muted, the account removed the conversation, or the
 * status fell outside the list) hears nothing. Best effort: the status is
 * stored either way, and the conversation shows on the next list fetch.
 */
export const publishConversationUpdate = async (
  env: Env,
  identity: InstanceIdentity,
  accountIds: ReadonlyArray<string>,
  statusId: string,
): Promise<void> => {
  for (const accountId of new Set(accountIds)) {
    try {
      const conversations = await listConversationsForAccount(
        env.DB,
        identity,
        accountId,
        CONVERSATION_WINDOW,
      );
      const conversation = conversations.isOk()
        ? conversations.value.find((entry) => entry.lastStatus.status.id === statusId)
        : undefined;
      if (!conversation) {
        continue;
      }
      const [payload] = await conversationDocuments(env, identity, accountId, [conversation]);
      await publishToHub(env, accountId, {
        channels: [{ kind: "Direct" }],
        event: { kind: "conversation", payload },
      });
    } catch {
      console.error(JSON.stringify({ kind: "ConversationNotPublished", accountId }));
    }
  }
};
