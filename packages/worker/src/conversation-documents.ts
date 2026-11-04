import type { InstanceIdentity } from "@tstodon/domain";
import { accountDocumentsByIds } from "./account-documents";
import type { ConversationSummary } from "./conversation-store";
import { statusDocumentsByIds } from "./status-documents";

/**
 * Mastodon Conversation entities for `viewerId`, in the order of
 * `conversations`. Participants may be remote (`r_…`) and a last status may be
 * a cached remote note; both render in bulk.
 */
export const conversationDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string,
  conversations: ReadonlyArray<ConversationSummary>,
): Promise<Record<string, unknown>[]> => {
  const [accounts, statuses] = await Promise.all([
    accountDocumentsByIds(
      env,
      identity,
      conversations.flatMap((conversation) => conversation.accountIds),
    ),
    statusDocumentsByIds(
      env,
      identity,
      conversations.map((conversation) => conversation.lastStatus.status.id),
      viewerId,
    ),
  ]);
  return conversations.map((conversation) => ({
    id: conversation.id,
    unread: conversation.unread,
    accounts: conversation.accountIds.flatMap((id) => accounts.get(id) ?? []),
    last_status: statuses.get(conversation.lastStatus.status.id) ?? null,
  }));
};
