import { warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { LocalStatus as LocalStatusValue } from "@tstodon/domain";
import { nowIso } from "./clock";
import { runD1, runD1BatchChunked, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { parseRow, toRepositoryError } from "./d1";
import { SUPPRESSED_ACCOUNT_IDS_SQL } from "./block-mute-store";
import { hydrateStatusRows, STATUS_SELECT } from "./status-store";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import { RemoteAccountId } from "./remote-account-id";
import {
  createList as createListSql,
  deleteList as deleteListSql,
  deleteListMember as deleteListMemberSql,
  deleteListRemoteMember as deleteListRemoteMemberSql,
  findListForAccount as findListForAccountSql,
  insertListMember as insertListMemberSql,
  insertListRemoteMember as insertListRemoteMemberSql,
  listListMembers as listListMembersSql,
  listListsContainingAccount as listListsContainingAccountSql,
  listListsContainingRemoteActor as listListsContainingRemoteActorSql,
  listListsForAccount as listListsForAccountSql,
  updateList as updateListSql,
} from "./generated/prisma/sql";

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

const memberFromRow = (raw: unknown): ListMember | undefined => {
  const row = parseRow(ListMemberRowSchema, raw);
  if (row.isErr()) {
    return undefined;
  }
  return row.value.kind === "LocalAccount"
    ? { kind: "LocalAccount", accountId: row.value.member }
    : { kind: "RemoteActor", actorUri: row.value.member };
};

const listsFromRows = (rows: ReadonlyArray<unknown>): AccountList[] =>
  rows.flatMap((raw) => {
    const row = parseRow(ListRowSchema, raw);
    return row.isOk() ? [listFromRow(row.value)] : [];
  });

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

export const toMastodonList = (
  list: AccountList,
): Readonly<{
  id: string;
  title: string;
  replies_policy: ListRepliesPolicy;
  exclusive: boolean;
}> => ({
  id: list.id,
  title: list.title,
  replies_policy: list.repliesPolicy,
  exclusive: list.exclusive,
});

export const listListsForAccount = async (
  db: D1Database,
  accountId: string,
): Promise<Result<AccountList[], RepositoryError>> =>
  runD1(async () => listsFromRows(await queryTyped(db, listListsForAccountSql(accountId))));

export const findListForAccount = async (
  db: D1Database,
  accountId: string,
  listId: string,
): Promise<Result<AccountList | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped(db, findListForAccountSql(listId, accountId));
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const raw = queried.value[0];
  if (!raw) {
    return ok(undefined);
  }
  const row = parseRow(ListRowSchema, raw);
  if (row.isErr()) {
    return err(toRepositoryError("invalid list row"));
  }
  return ok(listFromRow(row.value));
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
    const rows = await queryTyped<{ id: string }>(db, deleteListSql(listId, accountId));
    return rows.length > 0;
  });

/** The list's local and remote members, in the order they were added. */
export const listListMembers = async (
  db: D1Database,
  listId: string,
): Promise<Result<ListMember[], RepositoryError>> =>
  runD1(async () =>
    (await queryTyped(db, listListMembersSql(listId))).flatMap((raw) => memberFromRow(raw) ?? []),
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
    listsFromRows(
      await queryTyped(
        db,
        member.kind === "LocalAccount"
          ? listListsContainingAccountSql(ownerAccountId, member.accountId)
          : listListsContainingRemoteActorSql(ownerAccountId, member.actorUri),
      ),
    ),
  );

export const listListTimelineStatuses = async (
  db: D1Database,
  input: Readonly<{
    listId: string;
    ownerAccountId: string;
    repliesPolicy: ListRepliesPolicy;
    limit: number;
    maxId: string | undefined;
  }>,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    // Dynamic reply-policy SQL stays on D1 prepare (escape hatch).
    const replyFilter =
      input.repliesPolicy === "none"
        ? `AND in_reply_to_id IS NULL`
        : input.repliesPolicy === "followed"
          ? `AND (
               in_reply_to_id IS NULL
               OR EXISTS (
                 SELECT 1 FROM statuses parent
                 JOIN follows f ON f.target_account_id = parent.account_id
                 WHERE parent.id = statuses.in_reply_to_id
                   AND f.follower_account_id = ?
                   AND f.kind = 'Accepted'
               )
             )`
          : "";
    const binds: Array<string | number> = [input.listId];
    binds.push(input.ownerAccountId, input.ownerAccountId, input.ownerAccountId, nowIso());
    if (input.repliesPolicy === "followed") {
      binds.push(input.ownerAccountId);
    }
    const maxFilter = input.maxId ? `AND id < ?` : "";
    if (input.maxId) {
      binds.push(input.maxId);
    }
    binds.push(input.limit);
    const { results } = await db
      .prepare(
        `SELECT ${STATUS_SELECT} FROM statuses
         WHERE kind = 'LocalNote'
           AND visibility != 'direct'
           AND account_id IN (SELECT member_account_id FROM account_list_members WHERE list_id = ?)
           AND account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL}
           ${replyFilter}
           ${maxFilter}
         ORDER BY id DESC
         LIMIT ?`,
      )
      .bind(...binds)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });
