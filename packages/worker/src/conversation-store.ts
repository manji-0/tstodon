import { err, ok, type Result } from "neverthrow";
import type { LocalStatus as LocalStatusValue } from "@tstodon/domain";
import type { RepositoryError } from "./d1";
import { getConversationRead } from "./marker-store";
import { listMentionedAccountIds } from "./mention-store";
import {
  findStatusById,
  listDirectStatusesForAccount,
  resolveDirectConversationRoot,
} from "./status-store";

export type ConversationSummary = Readonly<{
  id: string;
  unread: boolean;
  accountIds: ReadonlyArray<string>;
  lastStatus: LocalStatusValue;
}>;

export const listConversationsForAccount = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<ConversationSummary[], RepositoryError>> => {
  const statuses = await listDirectStatusesForAccount(
    db,
    accountId,
    Math.max(limit * 10, 40),
    undefined,
  );
  if (statuses.isErr()) {
    return err(statuses.error);
  }
  const byRoot = new Map<string, LocalStatusValue[]>();
  for (const status of statuses.value) {
    const root = await resolveDirectConversationRoot(db, status);
    if (root.isErr()) {
      return err(root.error);
    }
    const bucket = byRoot.get(root.value) ?? [];
    bucket.push(status);
    byRoot.set(root.value, bucket);
  }

  const summaries: ConversationSummary[] = [];
  for (const [conversationId, thread] of byRoot) {
    const ordered = [...thread].toSorted((left, right) => right.id.localeCompare(left.id));
    const lastStatus = ordered[0];
    if (!lastStatus) {
      continue;
    }
    const participantIds = new Set<string>();
    for (const status of ordered) {
      participantIds.add(status.accountId);
      const mentions = await listMentionedAccountIds(db, status.id);
      if (mentions.isErr()) {
        return err(mentions.error);
      }
      for (const mentioned of mentions.value) {
        participantIds.add(mentioned);
      }
    }
    participantIds.delete(accountId);
    const read = await getConversationRead(db, accountId, conversationId);
    if (read.isErr()) {
      return err(read.error);
    }
    const unread = !read.value || lastStatus.id > read.value;
    summaries.push({
      id: conversationId,
      unread,
      accountIds: [...participantIds],
      lastStatus,
    });
  }

  return ok(
    summaries
      .toSorted((left, right) => right.lastStatus.id.localeCompare(left.lastStatus.id))
      .slice(0, limit),
  );
};

export const latestStatusIdInConversation = async (
  db: D1Database,
  accountId: string,
  conversationId: string,
): Promise<Result<string | undefined, RepositoryError>> => {
  const root = await findStatusById(db, conversationId);
  if (root.isErr()) {
    return err(root.error);
  }
  if (!root.value) {
    return ok(undefined);
  }
  const conversations = await listConversationsForAccount(db, accountId, 100);
  if (conversations.isErr()) {
    return err(conversations.error);
  }
  const match = conversations.value.find((conversation) => conversation.id === conversationId);
  return ok(match?.lastStatus.id);
};
