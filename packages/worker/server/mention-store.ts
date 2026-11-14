import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, type RepositoryError, runD1, runD1Batch } from "./d1";
import { d1PrepareTyped, CountedRow, queryTyped } from "./typed-sql";
import {
  deleteRemoteStatusRemoteMentions as deleteRemoteStatusRemoteMentionsSql,
  deleteStatusMentions as deleteStatusMentionsSql,
  deleteStatusRemoteMentions as deleteStatusRemoteMentionsSql,
  insertRemoteStatusMention as insertRemoteStatusMentionSql,
  insertRemoteStatusRemoteMention as insertRemoteStatusRemoteMentionSql,
  insertSilentRemoteStatusMention as insertSilentRemoteStatusMentionSql,
  isActiveRemoteStatusMention as isActiveRemoteStatusMentionSql,
  insertStatusMention as insertStatusMentionSql,
  insertStatusRemoteMention as insertStatusRemoteMentionSql,
  listRemoteStatusMentions as listRemoteStatusMentionsSql,
  listRemoteStatusRemoteMentions as listRemoteStatusRemoteMentionsSql,
  listShownRemoteStatusMentions as listShownRemoteStatusMentionsSql,
  listStatusMentionsByIds as listStatusMentionsByIdsSql,
  listStatusRemoteMentions as listStatusRemoteMentionsSql,
  silenceRemoteStatusMentionsExcept as silenceRemoteStatusMentionsExceptSql,
} from "./generated/prisma/sql";

const StatusIdAccountIdRow = z.object({ status_id: z.string(), account_id: z.string() });
const StatusIdActorUriRow = z.object({ status_id: z.string(), actor_uri: z.string() });

/**
 * Make the local accounts a cached remote note names the ones its document
 * names now. `mentioned` are its mentions; one written silent before becomes
 * a real one. `addressed` only may read the note: a silent mention, which
 * never replaces a real one. A real mention that is in neither becomes
 * silent: an `Update` dropped it, and Mastodon keeps the account's access
 * (`ProcessStatusUpdateService#update_mentions!`) rather than deleting the row.
 */
export const recordRemoteStatusMentions = async (
  db: D1Database,
  statusId: string,
  accounts: Readonly<{ mentioned: ReadonlyArray<string>; addressed: ReadonlyArray<string> }>,
): Promise<Result<void, RepositoryError>> => {
  const statements = [
    d1PrepareTyped(
      db,
      silenceRemoteStatusMentionsExceptSql(statusId, jsonStringArray([...accounts.mentioned])),
    ),
    ...accounts.mentioned.map((accountId) =>
      d1PrepareTyped(db, insertRemoteStatusMentionSql(statusId, accountId)),
    ),
    ...accounts.addressed.map((accountId) =>
      d1PrepareTyped(db, insertSilentRemoteStatusMentionSql(statusId, accountId)),
    ),
  ];
  const batched = await runD1Batch(db, statements);
  return batched.isErr() ? err(batched.error) : ok(undefined);
};

/**
 * Replace the remote actors a cached remote note mentions (its `Mention`
 * tags off this server), so an `Update` that adds or drops one keeps them in
 * step. Local accounts, and their silent mentions, are not touched.
 */
export const replaceRemoteStatusRemoteMentions = async (
  db: D1Database,
  statusId: string,
  actorUris: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  const batched = await runD1Batch(db, [
    d1PrepareTyped(db, deleteRemoteStatusRemoteMentionsSql(statusId)),
    ...actorUris.map((actorUri) =>
      d1PrepareTyped(db, insertRemoteStatusRemoteMentionSql(statusId, actorUri)),
    ),
  ]);
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

/** The mentions of each of `statusIds`, keyed by status id, read by the two queries given. */
const groupMentions = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
  query: Readonly<{
    locals: (idsJson: string) => Parameters<typeof queryTyped>[1];
    remotes: (idsJson: string) => Parameters<typeof queryTyped>[1];
  }>,
): Promise<Result<ReadonlyMap<string, StatusMentions>, RepositoryError>> => {
  const unique = [...new Set(statusIds)];
  if (unique.length === 0) {
    return ok(new Map<string, StatusMentions>());
  }
  const idsJson = jsonStringArray(unique);
  const queried = await runD1(async () =>
    Promise.all([
      queryTyped(db, query.locals(idsJson), StatusIdAccountIdRow),
      queryTyped(db, query.remotes(idsJson), StatusIdActorUriRow),
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

/** Local accounts and remote actors each local note mentions, keyed by status id. */
export const listStatusMentions = (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, StatusMentions>, RepositoryError>> =>
  groupMentions(db, statusIds, {
    locals: listStatusMentionsByIdsSql,
    remotes: listStatusRemoteMentionsSql,
  });

/**
 * Local accounts and remote actors each cached remote note shows as its
 * mentions, keyed by status id, each list in stored order. A silent mention,
 * which only lets the account see the note, is not shown.
 */
export const listShownRemoteStatusMentions = (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, StatusMentions>, RepositoryError>> =>
  groupMentions(db, statusIds, {
    locals: listShownRemoteStatusMentionsSql,
    remotes: listRemoteStatusRemoteMentionsSql,
  });

/**
 * Local accounts and remote actors each cached remote note addresses, keyed
 * by status id: every mention, the silent ones included, as a direct note's
 * conversation counts them (Mastodon's `participants_from_status`).
 */
export const listRemoteStatusMentions = (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, StatusMentions>, RepositoryError>> =>
  groupMentions(db, statusIds, {
    locals: listRemoteStatusMentionsSql,
    remotes: listRemoteStatusRemoteMentionsSql,
  });
