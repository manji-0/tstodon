import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, type RepositoryError, runD1, runD1Batch } from "./d1";
import { d1PrepareTyped, CountedRow, queryTyped } from "./typed-sql";
import {
  deleteStatusMentions as deleteStatusMentionsSql,
  deleteStatusRemoteMentions as deleteStatusRemoteMentionsSql,
  insertRemoteStatusMention as insertRemoteStatusMentionSql,
  insertSilentRemoteStatusMention as insertSilentRemoteStatusMentionSql,
  isActiveRemoteStatusMention as isActiveRemoteStatusMentionSql,
  insertStatusMention as insertStatusMentionSql,
  insertStatusRemoteMention as insertStatusRemoteMentionSql,
  isAccountMentionedOnRemoteStatus as isAccountMentionedOnRemoteStatusSql,
  isAccountMentionedOnStatus as isAccountMentionedOnStatusSql,
  listRemoteStatusMentions as listRemoteStatusMentionsSql,
  listStatusMentionsByIds as listStatusMentionsByIdsSql,
  listStatusRemoteMentions as listStatusRemoteMentionsSql,
} from "./generated/prisma/sql";

const StatusIdAccountIdRow = z.object({ status_id: z.string(), account_id: z.string() });
const OkRow = z.object({ ok: z.number() });
const StatusIdActorUriRow = z.object({ status_id: z.string(), actor_uri: z.string() });

/**
 * Record the local accounts a cached remote note addresses. A silent mention
 * written so the account can see the note becomes a real one.
 */
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

/**
 * Grant `accountId` access to a remote note without a mention notification,
 * as Mastodon's `Quote#ensure_quoted_access` (a silent mention). A mention
 * the note already addressed them with is left as it is.
 */
export const recordSilentRemoteStatusMention = async (
  db: D1Database,
  statusId: string,
  accountId: string,
): Promise<Result<void, RepositoryError>> => {
  const batched = await runD1Batch(db, [
    d1PrepareTyped(db, insertSilentRemoteStatusMentionSql(statusId, accountId)),
  ]);
  return batched.isErr() ? err(batched.error) : ok(undefined);
};

/** A mention the note addressed the account with, not one that only grants access. */
export const isActiveRemoteStatusMention = async (
  db: D1Database,
  statusId: string,
  accountId: string,
): Promise<Result<boolean, RepositoryError>> => {
  const rows = await runD1(async () =>
    queryTyped(db, isActiveRemoteStatusMentionSql(statusId, accountId), CountedRow),
  );
  return rows.isErr() ? err(rows.error) : ok(rows.value.length > 0);
};

export const isAccountMentionedOnRemoteStatus = async (
  db: D1Database,
  statusId: string,
  accountId: string,
): Promise<Result<boolean, RepositoryError>> => {
  const rows = await runD1(async () =>
    queryTyped(db, isAccountMentionedOnRemoteStatusSql(statusId, accountId), CountedRow),
  );
  return rows.isErr() ? err(rows.error) : ok(rows.value.length > 0);
};

/** Local account ids each remote status addresses, keyed by status id. */
export const listRemoteStatusMentions = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, ReadonlyArray<string>>, RepositoryError>> => {
  if (statusIds.length === 0) {
    return ok(new Map<string, string[]>());
  }
  const rows = await runD1(async () =>
    queryTyped(
      db,
      listRemoteStatusMentionsSql(jsonStringArray([...new Set(statusIds)])),
      StatusIdAccountIdRow,
    ),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  return ok(
    new Map(
      [...Map.groupBy(rows.value, (row) => row.status_id)].map(([statusId, mentioned]) => [
        statusId,
        mentioned.map((row) => row.account_id),
      ]),
    ),
  );
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
    return queryTyped(db, isAccountMentionedOnStatusSql(statusId, accountId), OkRow);
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
  const unique = [...new Set(statusIds)];
  if (unique.length === 0) {
    return ok(new Map<string, StatusMentions>());
  }
  const queried = await runD1(async () =>
    Promise.all([
      queryTyped(db, listStatusMentionsByIdsSql(jsonStringArray(unique)), StatusIdAccountIdRow),
      queryTyped(db, listStatusRemoteMentionsSql(jsonStringArray(unique)), StatusIdActorUriRow),
    ]),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  const [locals, remotes] = queried.value;
  const localsByStatus = Map.groupBy(locals, (row) => row.status_id);
  const remotesByStatus = Map.groupBy(remotes, (row) => row.status_id);
  const mentioning = new Set([...localsByStatus.keys(), ...remotesByStatus.keys()]);
  return ok(
    new Map(
      [...mentioning].map((statusId): [string, StatusMentions] => [
        statusId,
        {
          accountIds: (localsByStatus.get(statusId) ?? []).map((row) => row.account_id),
          actorUris: (remotesByStatus.get(statusId) ?? []).map((row) => row.actor_uri),
        },
      ]),
    ),
  );
};
