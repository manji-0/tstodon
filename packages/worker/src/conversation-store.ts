import { err, ok, type Result } from "neverthrow";
import type {
  InstanceIdentity,
  LocalStatus as LocalStatusValue,
  RemoteStatus,
} from "@tstodon/domain";
import type { RepositoryError } from "./d1";
import { getConversationRead } from "./marker-store";
import { nowIso } from "./clock";
import { runD1, type RepositoryError as StoreError } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import {
  getConversationHide as getConversationHideSql,
  upsertConversationHide as upsertConversationHideSql,
} from "./generated/prisma/sql";
import { parseLocalStatusId } from "./activitypub";
import { listStatusMentions } from "./mention-store";
import { RemoteAccountId } from "./remote-account-id";
import {
  findRemoteStatusReplyTargetByObjectUri,
  findRemoteStatusReplyTargets,
  listRemoteDirectStatusesForAccount,
  listRemoteStatusMentions,
} from "./remote-status-store";
import { CONTEXT_ANCESTOR_LIMIT, findStatusById, listStatusReplyUris } from "./status-store";
import { listDirectStatusesForAccount, resolveDirectConversationRoot } from "./direct-status-store";

/** A direct status in a conversation: a local note or a cached remote one. */
export type ConversationStatus =
  | Readonly<{ kind: "Local"; status: LocalStatusValue }>
  | Readonly<{ kind: "Remote"; status: RemoteStatus }>;

export type ConversationSummary = Readonly<{
  id: string;
  unread: boolean;
  /** Local account ids and remote account ids (`r_…`). */
  accountIds: ReadonlyArray<string>;
  lastStatus: ConversationStatus;
}>;

/**
 * The conversation a remote direct note belongs to: its `inReplyTo` chain is
 * followed through direct notes, remote or local, to the first one. The two
 * walks hand off to each other and share one step budget, since a remote
 * `inReplyTo` can be made to point back into the thread.
 */
const resolveRemoteConversationRoot = async (
  db: D1Database,
  identity: InstanceIdentity,
  statusId: string,
  budget: { steps: number },
): Promise<Result<string, RepositoryError>> => {
  const targets = await findRemoteStatusReplyTargets(db, [statusId]);
  if (targets.isErr()) {
    return err(targets.error);
  }
  let current = targets.value.get(statusId);
  if (!current) {
    return ok(statusId);
  }
  while (budget.steps > 0) {
    budget.steps -= 1;
    const parentUri = current.inReplyToUri;
    if (!parentUri) {
      break;
    }
    const localId = parseLocalStatusId(identity, parentUri);
    if (localId) {
      const parent = await findStatusById(db, localId);
      if (parent.isErr()) {
        return err(parent.error);
      }
      if (
        parent.value &&
        parent.value.kind === "LocalNote" &&
        parent.value.visibility.kind === "Direct"
      ) {
        return resolveLocalConversationRoot(db, identity, parent.value, budget);
      }
      break;
    }
    const parent = await findRemoteStatusReplyTargetByObjectUri(db, parentUri);
    if (parent.isErr()) {
      return err(parent.error);
    }
    if (!parent.value || !parent.value.direct) {
      break;
    }
    current = parent.value;
  }
  return ok(current.id);
};

/**
 * The conversation a local direct note belongs to: up its local reply chain,
 * then on into a remote direct note when the first local one answers it.
 */
const resolveLocalConversationRoot = async (
  db: D1Database,
  identity: InstanceIdentity,
  status: LocalStatusValue,
  budget: { steps: number },
): Promise<Result<string, RepositoryError>> => {
  const root = await resolveDirectConversationRoot(db, status);
  if (root.isErr()) {
    return err(root.error);
  }
  if (budget.steps <= 0) {
    return ok(root.value);
  }
  budget.steps -= 1;
  const uris = await listStatusReplyUris(db, [root.value]);
  if (uris.isErr()) {
    return err(uris.error);
  }
  const parentUri = uris.value.get(root.value);
  if (!parentUri) {
    return ok(root.value);
  }
  const parent = await findRemoteStatusReplyTargetByObjectUri(db, parentUri);
  if (parent.isErr()) {
    return err(parent.error);
  }
  return parent.value?.direct
    ? resolveRemoteConversationRoot(db, identity, parent.value.id, budget)
    : ok(root.value);
};

export const listConversationsForAccount = async (
  db: D1Database,
  identity: InstanceIdentity,
  accountId: string,
  limit: number,
): Promise<Result<ConversationSummary[], RepositoryError>> => {
  const window = Math.max(limit * 10, 40);
  const [locals, remotes] = await Promise.all([
    listDirectStatusesForAccount(db, accountId, window, undefined),
    listRemoteDirectStatusesForAccount(db, accountId, window, undefined),
  ]);
  if (locals.isErr()) {
    return err(locals.error);
  }
  if (remotes.isErr()) {
    return err(remotes.error);
  }
  const remoteMentions = await listRemoteStatusMentions(
    db,
    remotes.value.map((status) => status.id),
  );
  if (remoteMentions.isErr()) {
    return err(remoteMentions.error);
  }
  const localMentions = await listStatusMentions(
    db,
    locals.value.map((status) => status.id),
  );
  if (localMentions.isErr()) {
    return err(localMentions.error);
  }
  const byRoot = new Map<string, ConversationStatus[]>();
  const place = (root: string, entry: ConversationStatus): void => {
    const bucket = byRoot.get(root) ?? [];
    bucket.push(entry);
    byRoot.set(root, bucket);
  };
  for (const status of locals.value) {
    const root = await resolveLocalConversationRoot(db, identity, status, {
      steps: CONTEXT_ANCESTOR_LIMIT,
    });
    if (root.isErr()) {
      return err(root.error);
    }
    place(root.value, { kind: "Local", status });
  }
  for (const status of remotes.value) {
    const root = await resolveRemoteConversationRoot(db, identity, status.id, {
      steps: CONTEXT_ANCESTOR_LIMIT,
    });
    if (root.isErr()) {
      return err(root.error);
    }
    place(root.value, { kind: "Remote", status });
  }

  const summaries: ConversationSummary[] = [];
  for (const [conversationId, thread] of byRoot) {
    const ordered = [...thread].toSorted((left, right) =>
      right.status.id.localeCompare(left.status.id),
    );
    const lastStatus = ordered[0];
    if (!lastStatus) {
      continue;
    }
    const participantIds = new Set<string>();
    for (const entry of ordered) {
      if (entry.kind === "Remote") {
        participantIds.add(RemoteAccountId.encode(entry.status.actorUri));
        for (const mentioned of remoteMentions.value.get(entry.status.id) ?? []) {
          participantIds.add(mentioned);
        }
        continue;
      }
      participantIds.add(entry.status.accountId);
      const mentions = localMentions.value.get(entry.status.id);
      for (const mentioned of mentions?.accountIds ?? []) {
        participantIds.add(mentioned);
      }
      for (const actorUri of mentions?.actorUris ?? []) {
        participantIds.add(RemoteAccountId.encode(actorUri));
      }
    }
    const hidden = await conversationHiddenStatusId(db, accountId, conversationId);
    if (hidden.isErr()) {
      return err(hidden.error);
    }
    if (hidden.value !== undefined && lastStatus.status.id <= hidden.value) {
      // Removed from the list, and not revived by an older message.
      continue;
    }
    participantIds.delete(accountId);
    const read = await getConversationRead(db, accountId, conversationId);
    if (read.isErr()) {
      return err(read.error);
    }
    const unread = !read.value || lastStatus.status.id > read.value;
    summaries.push({
      id: conversationId,
      unread,
      accountIds: [...participantIds],
      lastStatus,
    });
  }

  return ok(
    summaries
      .toSorted((left, right) =>
        right.lastStatus.status.id.localeCompare(left.lastStatus.status.id),
      )
      .slice(0, limit),
  );
};

/** Newest status id the viewer saw when they removed this conversation. */
export const conversationHiddenStatusId = async (
  db: D1Database,
  accountId: string,
  conversationId: string,
): Promise<Result<string | undefined, StoreError>> => {
  const rows = await runD1(async () =>
    queryTyped<{ hidden_status_id: string }>(db, getConversationHideSql(accountId, conversationId)),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  return ok(rows.value[0]?.hidden_status_id);
};

/** Remove a conversation until a newer status arrives in it. */
export const hideConversation = async (
  db: D1Database,
  accountId: string,
  conversationId: string,
  hiddenStatusId: string,
): Promise<Result<void, StoreError>> =>
  runD1(async () => {
    await runTyped(
      db,
      upsertConversationHideSql(accountId, conversationId, hiddenStatusId, nowIso()),
    );
  });

export const latestStatusIdInConversation = async (
  db: D1Database,
  identity: InstanceIdentity,
  accountId: string,
  conversationId: string,
): Promise<Result<string | undefined, RepositoryError>> => {
  // A conversation may be rooted at a local or a remote status, so only the
  // viewer's own list decides whether it exists.
  const conversations = await listConversationsForAccount(db, identity, accountId, 100);
  if (conversations.isErr()) {
    return err(conversations.error);
  }
  const match = conversations.value.find((conversation) => conversation.id === conversationId);
  return ok(match?.lastStatus.status.id);
};
