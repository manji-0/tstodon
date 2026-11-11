import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import type {
  InstanceIdentity,
  LocalStatus as LocalStatusValue,
  RemoteStatus,
} from "@tstodon/domain";
import type { RepositoryError } from "./d1";
import { listConversationReads } from "./marker-store";
import { nowIso } from "./clock";
import { jsonStringArray, runD1, type RepositoryError as StoreError } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import {
  listConversationHides as listConversationHidesSql,
  upsertConversationHide as upsertConversationHideSql,
} from "./generated/prisma/sql";
import { parseLocalStatusId } from "./activitypub";
import { listStatusMentions, type StatusMentions } from "./mention-store";
import { RemoteAccountId } from "./remote-account-id";
import {
  findRemoteStatusReplyTargets,
  findRemoteStatusReplyTargetsByObjectUris,
  type RemoteReplyTarget,
} from "./remote-reply-store";
import { listRemoteDirectStatusesForAccount } from "./remote-status-timeline-store";
import { listRemoteStatusMentions } from "./mention-store";
import { CONTEXT_ANCESTOR_LIMIT } from "./status-store";
import {
  listDirectStatusesForAccount,
  resolveDirectConversationRoots,
} from "./direct-status-store";

const HiddenStatusIdRow = z.object({ conversation_id: z.string(), hidden_status_id: z.string() });

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
 * Where one status's walk to its conversation root stands, waiting on a
 * lookup. `fallback` is the root when the lookup does not continue the walk.
 */
type RootWalk =
  | Readonly<{ kind: "Done"; rootId: string }>
  /** Up the local direct replies from `statusId`; without `fallback`, it is a listed status. */
  | Readonly<{ kind: "Local"; statusId: string; fallback: string | undefined; steps: number }>
  | Readonly<{ kind: "RemoteStart"; statusId: string; steps: number }>
  | Readonly<{ kind: "RemoteParent"; uri: string; fallback: string; steps: number }>;

/**
 * One step up a remote direct note's `inReplyTo`. The step budget is shared
 * by the local and remote walks, since a remote `inReplyTo` can be made to
 * point back into the thread.
 */
const stepFromRemote = (
  identity: InstanceIdentity,
  current: RemoteReplyTarget,
  steps: number,
): RootWalk => {
  if (steps <= 0 || !current.inReplyToUri) {
    return { kind: "Done", rootId: current.id };
  }
  const localId = parseLocalStatusId(identity, current.inReplyToUri);
  return localId
    ? { kind: "Local", statusId: localId, fallback: current.id, steps: steps - 1 }
    : { kind: "RemoteParent", uri: current.inReplyToUri, fallback: current.id, steps: steps - 1 };
};

/**
 * The conversation each direct status belongs to: its reply chain is followed
 * through direct notes, local or remote, to the first one. Local runs of the
 * chain resolve in one query each round, and every walk in `statuses` advances
 * together, so the round trips depend on how often chains cross between local
 * and remote statuses, not on how many statuses there are.
 */
const resolveConversationRoots = async (
  db: D1Database,
  identity: InstanceIdentity,
  statuses: ReadonlyArray<ConversationStatus>,
): Promise<Result<ReadonlyMap<string, string>, RepositoryError>> => {
  let walks = new Map<string, RootWalk>(
    statuses.map((entry): [string, RootWalk] => [
      entry.status.id,
      entry.kind === "Local"
        ? {
            kind: "Local",
            statusId: entry.status.id,
            fallback: undefined,
            steps: CONTEXT_ANCESTOR_LIMIT,
          }
        : { kind: "RemoteStart", statusId: entry.status.id, steps: CONTEXT_ANCESTOR_LIMIT },
    ]),
  );
  for (;;) {
    const pending = [...walks.values()];
    const localIds = pending.flatMap((walk) => (walk.kind === "Local" ? [walk.statusId] : []));
    const remoteIds = pending.flatMap((walk) =>
      walk.kind === "RemoteStart" ? [walk.statusId] : [],
    );
    const parentUris = pending.flatMap((walk) => (walk.kind === "RemoteParent" ? [walk.uri] : []));
    if (localIds.length === 0 && remoteIds.length === 0 && parentUris.length === 0) {
      break;
    }
    const [locals, remotes, parents] = await Promise.all([
      resolveDirectConversationRoots(db, localIds),
      findRemoteStatusReplyTargets(db, remoteIds),
      findRemoteStatusReplyTargetsByObjectUris(db, parentUris),
    ]);
    if (locals.isErr()) {
      return err(locals.error);
    }
    if (remotes.isErr()) {
      return err(remotes.error);
    }
    if (parents.isErr()) {
      return err(parents.error);
    }
    const advance = (walk: RootWalk): RootWalk => {
      switch (walk.kind) {
        case "Done":
          return walk;
        case "Local": {
          const local = locals.value.get(walk.statusId);
          if (walk.fallback !== undefined && !local?.direct) {
            return { kind: "Done", rootId: walk.fallback };
          }
          const rootId = local?.rootId ?? walk.statusId;
          const uri = local?.rootInReplyToUri;
          if (walk.steps <= 0 || !uri) {
            return { kind: "Done", rootId };
          }
          return { kind: "RemoteParent", uri, fallback: rootId, steps: walk.steps - 1 };
        }
        case "RemoteStart": {
          const target = remotes.value.get(walk.statusId);
          return target
            ? stepFromRemote(identity, target, walk.steps)
            : { kind: "Done", rootId: walk.statusId };
        }
        case "RemoteParent": {
          const parent = parents.value.get(walk.uri);
          return parent?.direct
            ? stepFromRemote(identity, parent, walk.steps)
            : { kind: "Done", rootId: walk.fallback };
        }
      }
    };
    walks = new Map([...walks].map(([id, walk]) => [id, advance(walk)]));
  }
  return ok(
    new Map([...walks].flatMap(([id, walk]) => (walk.kind === "Done" ? [[id, walk.rootId]] : []))),
  );
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
    const roots = await resolveConversationRoots(db, identity, statuses);
    if (roots.isErr()) {
      return err(roots.error);
    }
    const started: Array<Readonly<{ rootId: string; lastStatusId: string }>> = [];
    for (const entry of statuses) {
      const rootId = roots.value.get(entry.status.id) ?? entry.status.id;
      const bucket = byRoot.get(rootId);
      if (bucket) {
        bucket.push(entry);
        continue;
      }
      byRoot.set(rootId, [entry]);
      if (inRange(entry.status.id)) {
        started.push({ rootId, lastStatusId: entry.status.id });
      }
    }
    const hidden = await conversationHiddenStatusIds(
      db,
      accountId,
      started.map((conversation) => conversation.rootId),
    );
    if (hidden.isErr()) {
      return err(hidden.error);
    }
    for (const { rootId, lastStatusId } of started) {
      const hiddenStatusId = hidden.value.get(rootId);
      // Removed from the list, and not revived by a newer message.
      if (hiddenStatusId === undefined || lastStatusId > hiddenStatusId) {
        listed.push(rootId);
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
  const reads = await listConversationReads(db, accountId, selected);
  if (reads.isErr()) {
    return err(reads.error);
  }
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
    const read = reads.value.get(conversationId);
    summaries.push({
      id: conversationId,
      unread: !read || lastStatus.status.id > read,
      accountIds: [...participantIds],
      lastStatus,
    });
  }
  return ok(summaries);
};

/** Newest status id the viewer saw when they removed each of these conversations, keyed by conversation id. */
const conversationHiddenStatusIds = async (
  db: D1Database,
  accountId: string,
  conversationIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, string>, StoreError>> => {
  if (conversationIds.length === 0) {
    return ok(new Map());
  }
  const rows = await runD1(async () =>
    queryTyped(
      db,
      listConversationHidesSql(accountId, jsonStringArray([...new Set(conversationIds)])),
      HiddenStatusIdRow,
    ),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  return ok(new Map(rows.value.map((row) => [row.conversation_id, row.hidden_status_id])));
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
