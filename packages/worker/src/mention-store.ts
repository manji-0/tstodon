import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, type RepositoryError, runD1, runD1Batch } from "./d1";
import { d1PrepareTyped, queryTyped } from "./typed-sql";
import {
  deleteStatusMentions as deleteStatusMentionsSql,
  deleteStatusRemoteMentions as deleteStatusRemoteMentionsSql,
  insertRemoteStatusMention as insertRemoteStatusMentionSql,
  insertStatusMention as insertStatusMentionSql,
  insertStatusRemoteMention as insertStatusRemoteMentionSql,
  isAccountMentionedOnRemoteStatus as isAccountMentionedOnRemoteStatusSql,
  isAccountMentionedOnStatus as isAccountMentionedOnStatusSql,
  listRemoteStatusMentions as listRemoteStatusMentionsSql,
  listStatusMentionsByIds as listStatusMentionsByIdsSql,
  listStatusRemoteMentions as listStatusRemoteMentionsSql,
} from "./generated/prisma/sql";

/** Record the local accounts a cached remote note addresses. */
export const recordRemoteStatusMentions = async (
  db: D1Database,
  statusId: string,
  accountIds: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  if (accountIds.length === 0) {
    return ok(undefined);
  }
  const batched = await runD1Batch(
    db,
    accountIds.map((accountId) =>
      d1PrepareTyped(db, insertRemoteStatusMentionSql(statusId, accountId)),
    ),
  );
  return batched.isErr() ? err(batched.error) : ok(undefined);
};

export const isAccountMentionedOnRemoteStatus = async (
  db: D1Database,
  statusId: string,
  accountId: string,
): Promise<Result<boolean, RepositoryError>> => {
  const rows = await runD1(async () =>
    queryTyped(db, isAccountMentionedOnRemoteStatusSql(statusId, accountId)),
  );
  return rows.isErr() ? err(rows.error) : ok(rows.value.length > 0);
};

/** Local account ids each remote status addresses, keyed by status id. */
export const listRemoteStatusMentions = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, ReadonlyArray<string>>, RepositoryError>> => {
  const mentions = new Map<string, string[]>();
  if (statusIds.length === 0) {
    return ok(mentions);
  }
  const rows = await runD1(async () =>
    queryTyped<{ status_id: string; account_id: string }>(
      db,
      listRemoteStatusMentionsSql(jsonStringArray([...new Set(statusIds)])),
    ),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  for (const row of rows.value) {
    const bucket = mentions.get(row.status_id) ?? [];
    bucket.push(row.account_id);
    mentions.set(row.status_id, bucket);
  }
  return ok(mentions);
};

export const replaceStatusMentions = async (
  db: D1Database,
  statusId: string,
  accountIds: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  const statements: D1PreparedStatement[] = [
    d1PrepareTyped(db, deleteStatusMentionsSql(statusId)),
    ...accountIds.map((accountId) =>
      d1PrepareTyped(db, insertStatusMentionSql(statusId, accountId)),
    ),
  ];
  const batched = await runD1Batch(db, statements);
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(undefined);
};

export const isAccountMentionedOnStatus = async (
  db: D1Database,
  statusId: string,
  accountId: string,
): Promise<Result<boolean, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped<{ ok: number }>(db, isAccountMentionedOnStatusSql(statusId, accountId));
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(queried.value.length > 0);
};

/** Replace the remote actors a local note mentions. */
export const replaceStatusRemoteMentions = async (
  db: D1Database,
  statusId: string,
  actorUris: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  const batched = await runD1Batch(db, [
    d1PrepareTyped(db, deleteStatusRemoteMentionsSql(statusId)),
    ...actorUris.map((actorUri) =>
      d1PrepareTyped(db, insertStatusRemoteMentionSql(statusId, actorUri)),
    ),
  ]);
  return batched.isErr() ? err(batched.error) : ok(undefined);
};

export type StatusMentions = Readonly<{
  accountIds: ReadonlyArray<string>;
  actorUris: ReadonlyArray<string>;
}>;

/** Local accounts and remote actors each local note mentions, keyed by status id. */
export const listStatusMentions = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, StatusMentions>, RepositoryError>> => {
  const mentions = new Map<string, { accountIds: string[]; actorUris: string[] }>();
  const unique = [...new Set(statusIds)];
  if (unique.length === 0) {
    return ok(mentions);
  }
  const queried = await runD1(async () =>
    Promise.all([
      queryTyped<{ status_id: string; account_id: string }>(
        db,
        listStatusMentionsByIdsSql(jsonStringArray(unique)),
      ),
      queryTyped<{ status_id: string; actor_uri: string }>(
        db,
        listStatusRemoteMentionsSql(jsonStringArray(unique)),
      ),
    ]),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  const entry = (statusId: string) => {
    const existing = mentions.get(statusId);
    if (existing) {
      return existing;
    }
    const created = { accountIds: [], actorUris: [] };
    mentions.set(statusId, created);
    return created;
  };
  const [locals, remotes] = queried.value;
  for (const row of locals) {
    entry(row.status_id).accountIds.push(row.account_id);
  }
  for (const row of remotes) {
    entry(row.status_id).actorUris.push(row.actor_uri);
  }
  return ok(mentions);
};
