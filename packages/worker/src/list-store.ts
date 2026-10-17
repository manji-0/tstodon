import { warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { LocalStatus as LocalStatusValue } from "@tstodon/domain";
import { nowIso } from "./clock";
import { runD1, runD1BatchChunked, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { parseRow, toRepositoryError } from "./schemas";
import { SUPPRESSED_ACCOUNT_IDS_SQL } from "./social-store";
import { STATUS_SELECT, hydrateStatusRows } from "./status-store";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import {
  createList as createListSql,
  deleteList as deleteListSql,
  deleteListMember as deleteListMemberSql,
  findListForAccount as findListForAccountSql,
  insertListMember as insertListMemberSql,
  listListMemberIds as listListMemberIdsSql,
  listListsContainingAccount as listListsContainingAccountSql,
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

warmSchemas([ListRepliesPolicySchema, ListRowSchema]);

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
  runD1(async () => {
    const results = await queryTyped(db, listListsForAccountSql(accountId));
    return results.flatMap((raw) => {
      const row = parseRow(ListRowSchema, raw);
      return row.isOk() ? [listFromRow(row.value)] : [];
    });
  });

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

export const listListMemberIds = async (
  db: D1Database,
  listId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped<{ member_account_id: string }>(
      db,
      listListMemberIdsSql(listId),
    );
    return results.map((row) => row.member_account_id);
  });

export const addListMembers = async (
  db: D1Database,
  listId: string,
  memberAccountIds: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  if (memberAccountIds.length === 0) {
    return ok(undefined);
  }
  const now = nowIso();
  const batched = await runD1BatchChunked(
    db,
    memberAccountIds.map((memberId) =>
      d1PrepareTyped(db, insertListMemberSql(listId, memberId, now)),
    ),
  );
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(undefined);
};

export const removeListMembers = async (
  db: D1Database,
  listId: string,
  memberAccountIds: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  if (memberAccountIds.length === 0) {
    return ok(undefined);
  }
  const batched = await runD1BatchChunked(
    db,
    memberAccountIds.map((memberId) => d1PrepareTyped(db, deleteListMemberSql(listId, memberId))),
  );
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(undefined);
};

export const listListsContainingAccount = async (
  db: D1Database,
  ownerAccountId: string,
  memberAccountId: string,
): Promise<Result<AccountList[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(
      db,
      listListsContainingAccountSql(ownerAccountId, memberAccountId),
    );
    return results.flatMap((raw) => {
      const row = parseRow(ListRowSchema, raw);
      return row.isOk() ? [listFromRow(row.value)] : [];
    });
  });

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
