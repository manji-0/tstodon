import type { ApiListJSON } from "@tstodon/api";
import { warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { OutboundFollow, type LocalStatus as LocalStatusValue } from "@tstodon/domain";
import { nowIso } from "./clock";
import { runD1, runD1BatchChunked, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { findFollowKind } from "./follow-store";
import { findOutboundFollow } from "./outbound-follow-store";
import { SUPPRESSED_ACCOUNT_IDS_SQL } from "./block-mute-store";
import { hydrateStatusRows, STATUS_SELECT } from "./status-store";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import { RemoteAccountId } from "./remote-account-id";
import {
  FEED_LANGUAGES_SQL,
  FEED_SUSPENDED_AUTHORS_SQL,
  feedLocalReblogsSql,
  feedLocalRepliesSql,
  type ListFeed,
} from "./followed-feed";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import {
  createList as createListSql,
  deleteList as deleteListSql,
  deleteListMember as deleteListMemberSql,
  deleteListRemoteMember as deleteListRemoteMemberSql,
  findListForAccount as findListForAccountSql,
  insertListMember as insertListMemberSql,
  insertListRemoteMember as insertListRemoteMemberSql,
  insertListRemoteMemberOfFollow as insertListRemoteMemberOfFollowSql,
  listListMembers as listListMembersSql,
  listListsContainingAccount as listListsContainingAccountSql,
  listListsContainingRemoteActor as listListsContainingRemoteActorSql,
  listListsForAccount as listListsForAccountSql,
  updateList as updateListSql,
} from "./generated/prisma/sql";

const IdRow = z.object({ id: z.string() });

export const ListRepliesPolicySchema = z.union([
  z.literal("followed"),
  z.literal("list"),
  z.literal("none"),
]);
export type ListRepliesPolicy = z.infer<typeof ListRepliesPolicySchema>;

const ListRowSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  title: z.string().min(1),
  replies_policy: ListRepliesPolicySchema,
  exclusive: z.number(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

const ListMemberSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("LocalAccount"), accountId: z.string().min(1) }),
  /** A remote actor is on a list through the owner's accepted follow of it. */
  z.object({ kind: z.literal("RemoteActor"), actorUri: z.string().min(1) }),
]);
export type ListMember = z.infer<typeof ListMemberSchema>;

const ListMemberRowSchema = z.object({
  kind: z.union([z.literal("LocalAccount"), z.literal("RemoteActor")]),
  member: z.string().min(1),
});

warmSchemas([ListRepliesPolicySchema, ListRowSchema, ListMemberSchema, ListMemberRowSchema]);

export const ListMember = {
  schema: ListMemberSchema,
  /** The member a Mastodon account id names: an `r_…` id is a remote actor. */
  fromAccountId: (id: string): ListMember => {
    const actorUri = RemoteAccountId.decode(id);
    return actorUri.isOk()
      ? { kind: "RemoteActor", actorUri: actorUri.value }
      : { kind: "LocalAccount", accountId: id };
  },
  accountId: (member: ListMember): string =>
    member.kind === "LocalAccount" ? member.accountId : RemoteAccountId.encode(member.actorUri),
} as const;

const memberFromRow = (row: z.infer<typeof ListMemberRowSchema>): ListMember =>
  row.kind === "LocalAccount"
    ? { kind: "LocalAccount", accountId: row.member }
    : { kind: "RemoteActor", actorUri: row.member };

export type AccountList = Readonly<{
  id: string;
  accountId: string;
  title: string;
  repliesPolicy: ListRepliesPolicy;
  exclusive: boolean;
}>;

const listFromRow = (row: z.infer<typeof ListRowSchema>): AccountList => ({
  id: row.id,
  accountId: row.account_id,
  title: row.title,
  repliesPolicy: row.replies_policy,
  exclusive: row.exclusive !== 0,
});

export const toMastodonList = (list: AccountList): ApiListJSON => ({
  id: list.id,
  title: list.title,
  replies_policy: list.repliesPolicy,
  exclusive: list.exclusive,
});

export const listListsForAccount = async (
  db: D1Database,
  accountId: string,
): Promise<Result<AccountList[], RepositoryError>> =>
  runD1(async () =>
    (await queryTyped(db, listListsForAccountSql(accountId), ListRowSchema)).map(listFromRow),
  );

export const findListForAccount = async (
  db: D1Database,
  accountId: string,
  listId: string,
): Promise<Result<AccountList | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped(db, findListForAccountSql(listId, accountId), ListRowSchema);
  });
  return queried.map((rows) => (rows[0] === undefined ? undefined : listFromRow(rows[0])));
};

export const createList = async (
  db: D1Database,
  accountId: string,
  input: Readonly<{ title: string; repliesPolicy?: ListRepliesPolicy; exclusive?: boolean }>,
): Promise<Result<AccountList, RepositoryError>> => {
  const id = newEntityId();
  const now = nowIso();
  const repliesPolicy = input.repliesPolicy ?? "list";
  const exclusive = input.exclusive ?? false;
  const written = await runD1(async () => {
    await runTyped(
      db,
      createListSql(id, accountId, input.title, repliesPolicy, exclusive ? 1 : 0, now, now),
    );
  });
  if (written.isErr()) {
    return err(written.error);
  }
  return ok({
    id,
    accountId,
    title: input.title,
    repliesPolicy,
    exclusive,
  });
};

export const updateList = async (
  db: D1Database,
  accountId: string,
  listId: string,
  input: Readonly<{ title?: string; repliesPolicy?: ListRepliesPolicy; exclusive?: boolean }>,
): Promise<Result<AccountList | undefined, RepositoryError>> => {
  const existing = await findListForAccount(db, accountId, listId);
  if (existing.isErr()) {
    return err(existing.error);
  }
  if (!existing.value) {
    return ok(undefined);
  }
  const title = input.title?.trim() || existing.value.title;
  const repliesPolicy = input.repliesPolicy ?? existing.value.repliesPolicy;
  const exclusive = input.exclusive ?? existing.value.exclusive;
  const written = await runD1(async () => {
    await runTyped(
      db,
      updateListSql(title, repliesPolicy, exclusive ? 1 : 0, nowIso(), listId, accountId),
    );
  });
  if (written.isErr()) {
    return err(written.error);
  }
  return ok({
    id: listId,
    accountId,
    title,
    repliesPolicy,
    exclusive,
  });
};

export const deleteList = async (
  db: D1Database,
  accountId: string,
  listId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, deleteListSql(listId, accountId), IdRow);
    return rows.length > 0;
  });

/** The list's local and remote members, in the order they were added. */
export const listListMembers = async (
  db: D1Database,
  listId: string,
): Promise<Result<ListMember[], RepositoryError>> =>
  runD1(async () =>
    (await queryTyped(db, listListMembersSql(listId), ListMemberRowSchema)).map(memberFromRow),
  );

const insertMemberSql = (listId: string, member: ListMember, now: string) =>
  member.kind === "LocalAccount"
    ? insertListMemberSql(listId, member.accountId, now)
    : insertListRemoteMemberSql(listId, member.actorUri, now);

const deleteMemberSql = (listId: string, member: ListMember) =>
  member.kind === "LocalAccount"
    ? deleteListMemberSql(listId, member.accountId)
    : deleteListRemoteMemberSql(listId, member.actorUri);

/**
 * The first of `members` that `ownerId` may not put on a list, as Mastodon's
 * `ListAccount` requires a followed account: a local one the owner follows
 * or has asked to follow (or the owner itself), a remote one the owner
 * follows; `undefined` when every member may go on.
 */
export const findUnfollowedMember = async (
  db: D1Database,
  ownerId: string,
  members: ReadonlyArray<ListMember>,
): Promise<Result<ListMember | undefined, RepositoryError>> => {
  for (const member of members) {
    const followed = await isFollowedMember(db, ownerId, member);
    if (followed.isErr()) {
      return err(followed.error);
    }
    if (!followed.value) {
      return ok(member);
    }
  }
  return ok(undefined);
};

const isFollowedMember = async (
  db: D1Database,
  ownerId: string,
  member: ListMember,
): Promise<Result<boolean, RepositoryError>> => {
  switch (member.kind) {
    case "LocalAccount":
      return member.accountId === ownerId
        ? ok(true)
        : (await findFollowKind(db, ownerId, member.accountId)).map((kind) => kind !== undefined);
    case "RemoteActor":
      return (await findOutboundFollow(db, ownerId, member.actorUri)).map(
        (follow) => OutboundFollow.relationship(follow).following,
      );
  }
};

/**
 * Add members to the list. A remote actor goes in only while the list's owner
 * follows it (accepted); otherwise its insert adds nothing.
 */
export const addListMembers = async (
  db: D1Database,
  listId: string,
  members: ReadonlyArray<ListMember>,
): Promise<Result<void, RepositoryError>> => {
  if (members.length === 0) {
    return ok(undefined);
  }
  const now = nowIso();
  const batched = await runD1BatchChunked(
    db,
    members.map((member) => d1PrepareTyped(db, insertMemberSql(listId, member, now))),
  );
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(undefined);
};

export const removeListMembers = async (
  db: D1Database,
  listId: string,
  members: ReadonlyArray<ListMember>,
): Promise<Result<void, RepositoryError>> => {
  if (members.length === 0) {
    return ok(undefined);
  }
  const batched = await runD1BatchChunked(
    db,
    members.map((member) => d1PrepareTyped(db, deleteMemberSql(listId, member))),
  );
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(undefined);
};

export const listListsContainingMember = async (
  db: D1Database,
  ownerAccountId: string,
  member: ListMember,
): Promise<Result<AccountList[], RepositoryError>> =>
  runD1(async () =>
    (
      await queryTyped(
        db,
        member.kind === "LocalAccount"
          ? listListsContainingAccountSql(ownerAccountId, member.accountId)
          : listListsContainingRemoteActorSql(ownerAccountId, member.actorUri),
        ListRowSchema,
      )
    ).map(listFromRow),
  );

export const listListTimelineStatuses = async (
  db: D1Database,
  input: Readonly<{
    feed: ListFeed;
    ownerAccountId: string;
    limit: number;
    cursor: IdCursor;
  }>,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    // The reply policy's SQL depends on the list, so this stays on D1 prepare.
    const replies = feedLocalRepliesSql(input.feed, input.ownerAccountId);
    const now = nowIso();
    const reblogs = feedLocalReblogsSql(input.ownerAccountId, now);
    const { where, order, binds: cursorBinds } = idCursorFragment(input.cursor);
    const binds = [
      input.ownerAccountId,
      input.ownerAccountId,
      input.ownerAccountId,
      input.ownerAccountId,
      input.ownerAccountId,
      now,
      ...reblogs.binds,
      input.ownerAccountId,
      ...replies.binds,
      ...cursorBinds,
      input.limit,
      input.feed.listId,
      input.limit,
    ];
    // Each member's statuses are searched on their own, newest first, and stop
    // at `limit`: the page is the first `limit` of those, so a page reads at
    // most `limit` statuses per member instead of every status they wrote.
    const { results } = await db
      .prepare(
        `SELECT ${STATUS_SELECT} FROM statuses WHERE id IN (
           SELECT page.id FROM account_list_members member
           JOIN statuses page ON page.id IN (
             SELECT id FROM statuses
             WHERE account_id = member.member_account_id
               AND visibility != 'direct'
               -- Mastodon feeds a list only from members the owner follows (accepted) and the owner.
               AND (account_id = ? OR account_id IN (
                 SELECT target_account_id FROM follows WHERE follower_account_id = ? AND kind = 'Accepted'
               ))
               AND account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL}
               ${FEED_SUSPENDED_AUTHORS_SQL}
               ${reblogs.sql}
               ${FEED_LANGUAGES_SQL}
               ${replies.sql}
               ${where} ${order}
             LIMIT ?
           )
           WHERE member.list_id = ?
         )
         ${order} LIMIT ?`,
      )
      .bind(...binds)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

/**
 * Put `to` on `lists` of `ownerId` in place of `from`, as Mastodon moves list
 * memberships along with a moved follow. A remote `to` goes in through the
 * owner's follow of it, requested or accepted (the `Accept` may not have come
 * yet); the owner must already have that follow. A remote `from` leaves with
 * its follow, which the caller deletes next.
 */
export const replaceListMember = async (
  db: D1Database,
  ownerId: string,
  lists: ReadonlyArray<AccountList>,
  from: ListMember,
  to: ListMember,
): Promise<Result<void, RepositoryError>> => {
  if (lists.length === 0) {
    return ok(undefined);
  }
  const now = nowIso();
  const statements = lists.flatMap((list) => [
    d1PrepareTyped(
      db,
      to.kind === "LocalAccount"
        ? insertListMemberSql(list.id, to.accountId, now)
        : insertListRemoteMemberOfFollowSql(list.id, ownerId, to.actorUri, now),
    ),
    ...(from.kind === "LocalAccount"
      ? [d1PrepareTyped(db, deleteListMemberSql(list.id, from.accountId))]
      : []),
  ]);
  const batched = await runD1BatchChunked(db, statements);
  return batched.isErr() ? err(batched.error) : ok(undefined);
};
