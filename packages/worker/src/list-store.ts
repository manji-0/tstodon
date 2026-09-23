import { warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { LocalStatus as LocalStatusValue } from "@tstodon/domain";
import { nowIso } from "./clock";
import { runD1, runD1BatchChunked, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { parseRow, toRepositoryError } from "./schemas";
import { STATUS_SELECT, hydrateStatusRows } from "./status-store";

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
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

warmSchemas([ListRepliesPolicySchema, ListRowSchema]);

export type AccountList = Readonly<{
  id: string;
  accountId: string;
  title: string;
  repliesPolicy: ListRepliesPolicy;
}>;

const listFromRow = (row: z.infer<typeof ListRowSchema>): AccountList => ({
  id: row.id,
  accountId: row.account_id,
  title: row.title,
  repliesPolicy: row.replies_policy,
});

export const toMastodonList = (
  list: AccountList,
): Readonly<{ id: string; title: string; replies_policy: ListRepliesPolicy }> => ({
  id: list.id,
  title: list.title,
  replies_policy: list.repliesPolicy,
});

export const listListsForAccount = async (
  db: D1Database,
  accountId: string,
): Promise<Result<AccountList[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT id, account_id, title, replies_policy, created_at, updated_at
         FROM account_lists
         WHERE account_id = ?
         ORDER BY created_at DESC`,
      )
      .bind(accountId)
      .all();
    return (results ?? []).flatMap((raw) => {
      const row = parseRow(ListRowSchema, raw);
      return row.isOk() ? [listFromRow(row.value)] : [];
    });
  });

export const findListForAccount = async (
  db: D1Database,
  accountId: string,
  listId: string,
): Promise<Result<AccountList | undefined, RepositoryError>> => {
  const queried = await runD1(() =>
    db
      .prepare(
        `SELECT id, account_id, title, replies_policy, created_at, updated_at
         FROM account_lists
         WHERE id = ? AND account_id = ?`,
      )
      .bind(listId, accountId)
      .first(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  if (!queried.value) {
    return ok(undefined);
  }
  const row = parseRow(ListRowSchema, queried.value);
  if (row.isErr()) {
    return err(toRepositoryError("invalid list row"));
  }
  return ok(listFromRow(row.value));
};

export const createList = async (
  db: D1Database,
  accountId: string,
  input: Readonly<{ title: string; repliesPolicy?: ListRepliesPolicy }>,
): Promise<Result<AccountList, RepositoryError>> => {
  const id = newEntityId();
  const now = nowIso();
  const repliesPolicy = input.repliesPolicy ?? "list";
  const written = await runD1(async () => {
    await db
      .prepare(
        `INSERT INTO account_lists (id, account_id, title, replies_policy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, accountId, input.title, repliesPolicy, now, now)
      .run();
  });
  if (written.isErr()) {
    return err(written.error);
  }
  return ok({
    id,
    accountId,
    title: input.title,
    repliesPolicy,
  });
};

export const updateList = async (
  db: D1Database,
  accountId: string,
  listId: string,
  input: Readonly<{ title?: string; repliesPolicy?: ListRepliesPolicy }>,
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
  const written = await runD1(async () => {
    await db
      .prepare(
        `UPDATE account_lists
         SET title = ?, replies_policy = ?, updated_at = ?
         WHERE id = ? AND account_id = ?`,
      )
      .bind(title, repliesPolicy, nowIso(), listId, accountId)
      .run();
  });
  if (written.isErr()) {
    return err(written.error);
  }
  return ok({
    id: listId,
    accountId,
    title,
    repliesPolicy,
  });
};

export const deleteList = async (
  db: D1Database,
  accountId: string,
  listId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const result = await db
      .prepare(`DELETE FROM account_lists WHERE id = ? AND account_id = ?`)
      .bind(listId, accountId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  });

export const listListMemberIds = async (
  db: D1Database,
  listId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT member_account_id FROM account_list_members
         WHERE list_id = ?
         ORDER BY created_at ASC`,
      )
      .bind(listId)
      .all<{ member_account_id: string }>();
    return (results ?? []).map((row) => row.member_account_id);
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
  const insert = db.prepare(
    `INSERT OR IGNORE INTO account_list_members (list_id, member_account_id, created_at)
     VALUES (?, ?, ?)`,
  );
  const batched = await runD1BatchChunked(
    db,
    memberAccountIds.map((memberId) => insert.bind(listId, memberId, now)),
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
  const del = db.prepare(
    `DELETE FROM account_list_members WHERE list_id = ? AND member_account_id = ?`,
  );
  const batched = await runD1BatchChunked(
    db,
    memberAccountIds.map((memberId) => del.bind(listId, memberId)),
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
    const { results } = await db
      .prepare(
        `SELECT l.id, l.account_id, l.title, l.replies_policy, l.created_at, l.updated_at
         FROM account_lists l
         JOIN account_list_members m ON m.list_id = l.id
         WHERE l.account_id = ? AND m.member_account_id = ?
         ORDER BY l.created_at DESC`,
      )
      .bind(ownerAccountId, memberAccountId)
      .all();
    return (results ?? []).flatMap((raw) => {
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
           ${replyFilter}
           ${maxFilter}
         ORDER BY id DESC
         LIMIT ?`,
      )
      .bind(...binds)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });
