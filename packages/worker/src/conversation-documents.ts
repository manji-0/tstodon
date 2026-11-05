import type { InstanceIdentity } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { accountDocumentsByIds } from "./account-documents";
import type { RepositoryError } from "./d1";
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
): Promise<Result<Record<string, unknown>[], RepositoryError>> => {
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
  return accounts.map((byId) =>
    conversations.map((conversation) => ({
      id: conversation.id,
      unread: conversation.unread,
      accounts: conversation.accountIds.flatMap((id) => byId.get(id) ?? []),
      last_status: statuses.get(conversation.lastStatus.status.id) ?? null,
    })),
  );
};
