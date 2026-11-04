import { type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import {
  deleteAccountAlias as deleteAccountAliasSql,
  insertAccountAliasOrIgnore as insertAccountAliasOrIgnoreSql,
  listAccountAliases as listAccountAliasesSql,
} from "./generated/prisma/sql";
import { newEntityId } from "./ids";
import { queryTyped, runTyped } from "./typed-sql";

/** An account a local account says it moved from (Mastodon's `AccountAlias`). */
export type AccountAlias = Readonly<{
  id: string;
  /** The handle as entered and resolved: `user@domain`, or a local username. */
  acct: string;
  actorUri: string;
}>;

const AliasRowSchema = z.object({
  id: z.string().min(1),
  acct: z.string().min(1),
  actor_uri: z.string().min(1),
});

/** The account's aliases, oldest first. */
export const listAccountAliases = async (
  db: D1Database,
  accountId: string,
): Promise<Result<ReadonlyArray<AccountAlias>, RepositoryError>> =>
  runD1(async () =>
    (await queryTyped(db, listAccountAliasesSql(accountId), AliasRowSchema)).map((row) => ({
      id: row.id,
      acct: row.acct,
      actorUri: row.actor_uri,
    })),
  );

/** Add an alias; adding one the account already has changes nothing. */
export const addAccountAlias = async (
  db: D1Database,
  accountId: string,
  alias: Readonly<{ acct: string; actorUri: string }>,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      insertAccountAliasOrIgnoreSql(newEntityId(), accountId, alias.acct, alias.actorUri, nowIso()),
    );
  });

export const removeAccountAlias = async (
  db: D1Database,
  accountId: string,
  aliasId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteAccountAliasSql(accountId, aliasId));
  });
