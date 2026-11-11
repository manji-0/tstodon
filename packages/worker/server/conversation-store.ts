import { z } from "zod";
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
import { listStatusMentions, type StatusMentions } from "./mention-store";
import { RemoteAccountId } from "./remote-account-id";
import {
  findRemoteStatusReplyTargetByObjectUri,
  findRemoteStatusReplyTargets,
} from "./remote-reply-store";
import { listRemoteDirectStatusesForAccount } from "./remote-status-timeline-store";
import { listRemoteStatusMentions } from "./mention-store";
import { CONTEXT_ANCESTOR_LIMIT, findStatusById, listStatusReplyUris } from "./status-store";
import { listDirectStatusesForAccount, resolveDirectConversationRoot } from "./direct-status-store";

const HiddenStatusIdRow = z.object({ hidden_status_id: z.string() });

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

/**
 * Which conversations a list asks for. Like Mastodon's `AccountConversation`,
 * a conversation pages by its last status id: `max_id` keeps the ones whose
 * last status is older, `since_id` and `min_id` the ones whose last status is
 * newer, the newest (`since_id`) or the oldest (`min_id`) `limit` of them.
 */
export type ConversationPage = Readonly<{
  limit: number;
  maxId?: string | undefined;
  sinceId?: string | undefined;
  minId?: string | undefined;
}>;

/**
 * How many direct statuses one list call groups at most. Conversations are not
 * stored but grouped from the viewer's direct statuses, newest first, so a
 * page deep in the list reads every status above it; past this many, the
 * list ends there.
 */
const MAX_SCANNED_DIRECT_STATUSES = 1000;

/** Up to `size` of the viewer's direct statuses older than `before`, local and remote, newest first. */
const directStatusBatch = async (
  db: D1Database,
  accountId: string,
  size: number,
  before: string | undefined,
): Promise<
  Result<Readonly<{ statuses: ConversationStatus[]; exhausted: boolean }>, RepositoryError>
> => {
  const [locals, remotes] = await Promise.all([
    listDirectStatusesForAccount(db, accountId, size, before),
    listRemoteDirectStatusesForAccount(db, accountId, size, before),
  ]);
  if (locals.isErr()) {
    return err(locals.error);
  }
  if (remotes.isErr()) {
    return err(remotes.error);
  }
  const merged: ConversationStatus[] = [
    ...locals.value.map((status): ConversationStatus => ({ kind: "Local", status })),
    ...remotes.value.map((status): ConversationStatus => ({ kind: "Remote", status })),
  ].toSorted((left, right) => right.status.id.localeCompare(left.status.id));
  return ok({
    statuses: merged.slice(0, size),
    exhausted: locals.value.length < size && remotes.value.length < size && merged.length <= size,
  });
};

export const listConversationsForAccount = async (
  db: D1Database,
  identity: InstanceIdentity,
  accountId: string,
  page: ConversationPage,
): Promise<Result<ConversationSummary[], RepositoryError>> => {
  const { limit, maxId } = page;
  // Mastodon's `min_id` wins over `since_id`.
  const lowerBound = page.minId ?? page.sinceId;
  const inRange = (lastStatusId: string): boolean =>
    (maxId === undefined || lastStatusId < maxId) &&
    (lowerBound === undefined || lastStatusId > lowerBound);
  const batchSize = Math.max(limit * 10, 40);

  // Statuses are read newest first, so the first status seen of a
  // conversation is its last one, and conversations turn up in list order.
  const byRoot = new Map<string, ConversationStatus[]>();
  const localMentions = new Map<string, StatusMentions>();
  const remoteMentions = new Map<string, ReadonlyArray<string>>();
  const listed: string[] = [];
  let scanned = 0;
  let before: string | undefined;
  for (;;) {
    const batch = await directStatusBatch(db, accountId, batchSize, before);
    if (batch.isErr()) {
      return err(batch.error);
    }
    const { statuses, exhausted } = batch.value;
    const [locals, remotes] = await Promise.all([
      listStatusMentions(
        db,
        statuses.flatMap((entry) => (entry.kind === "Local" ? [entry.status.id] : [])),
      ),
      listRemoteStatusMentions(
        db,
        statuses.flatMap((entry) => (entry.kind === "Remote" ? [entry.status.id] : [])),
      ),
    ]);
    if (locals.isErr()) {
      return err(locals.error);
    }
    if (remotes.isErr()) {
      return err(remotes.error);
    }
    for (const [id, mentions] of locals.value) {
      localMentions.set(id, mentions);
    }
    for (const [id, mentions] of remotes.value) {
      remoteMentions.set(id, mentions);
    }
    for (const entry of statuses) {
      const root =
        entry.kind === "Local"
          ? await resolveLocalConversationRoot(db, identity, entry.status, {
              steps: CONTEXT_ANCESTOR_LIMIT,
            })
          : await resolveRemoteConversationRoot(db, identity, entry.status.id, {
              steps: CONTEXT_ANCESTOR_LIMIT,
            });
      if (root.isErr()) {
        return err(root.error);
      }
      const bucket = byRoot.get(root.value);
      if (bucket) {
        bucket.push(entry);
        continue;
      }
      byRoot.set(root.value, [entry]);
      if (!inRange(entry.status.id)) {
        continue;
      }
      const hidden = await conversationHiddenStatusId(db, accountId, root.value);
      if (hidden.isErr()) {
        return err(hidden.error);
      }
      // Removed from the list, and not revived by a newer message.
      if (hidden.value === undefined || entry.status.id > hidden.value) {
        listed.push(root.value);
      }
    }
    scanned += statuses.length;
    const oldest = statuses.at(-1)?.status.id;
    if (
      exhausted ||
      oldest === undefined ||
      scanned >= MAX_SCANNED_DIRECT_STATUSES ||
      (lowerBound !== undefined && oldest <= lowerBound) ||
      (page.minId === undefined && listed.length >= limit)
    ) {
      break;
    }
    before = oldest;
  }

  // `listed` runs newest first; `min_id` takes the oldest `limit` of it.
  const selected = page.minId === undefined ? listed.slice(0, limit) : listed.slice(-limit);
  const summaries: ConversationSummary[] = [];
  for (const conversationId of selected) {
    const thread = byRoot.get(conversationId) ?? [];
    const lastStatus = thread[0];
    if (!lastStatus) {
      continue;
    }
    const participantIds = new Set(
      thread.flatMap((entry) => {
        if (entry.kind === "Remote") {
          return [
            RemoteAccountId.encode(entry.status.actorUri),
            ...(remoteMentions.get(entry.status.id) ?? []),
          ];
        }
        const mentions = localMentions.get(entry.status.id);
        return [
          entry.status.accountId,
          ...(mentions?.accountIds ?? []),
          ...(mentions?.actorUris ?? []).map((actorUri) => RemoteAccountId.encode(actorUri)),
        ];
      }),
    );
    participantIds.delete(accountId);
    const read = await getConversationRead(db, accountId, conversationId);
    if (read.isErr()) {
      return err(read.error);
    }
    summaries.push({
      id: conversationId,
      unread: !read.value || lastStatus.status.id > read.value,
      accountIds: [...participantIds],
      lastStatus,
    });
  }
  return ok(summaries);
};

/** Newest status id the viewer saw when they removed this conversation. */
export const conversationHiddenStatusId = async (
  db: D1Database,
  accountId: string,
  conversationId: string,
): Promise<Result<string | undefined, StoreError>> => {
  const rows = await runD1(async () =>
    queryTyped(db, getConversationHideSql(accountId, conversationId), HiddenStatusIdRow),
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
  const conversations = await listConversationsForAccount(db, identity, accountId, { limit: 100 });
  if (conversations.isErr()) {
    return err(conversations.error);
  }
  const match = conversations.value.find((conversation) => conversation.id === conversationId);
  return ok(match?.lastStatus.status.id);
};
