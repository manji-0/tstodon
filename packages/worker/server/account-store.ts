import {
  AccessEmail,
  AccountId,
  IsoInstant,
  type LocalAccount,
  Username,
  Visibility,
} from "@tstodon/domain";
import { schemaResult, Sensitive, type SensitiveValue, warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, okValues, type RepositoryError, runD1 } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import { quotePolicyFromSql, quotePolicySql, visibilitySql } from "./sql-enums";
import {
  countAccounts as countAccountsSql,
  countSearchAccounts as countSearchAccountsSql,
  deleteAccount as deleteAccountSql,
  findAccountByAuthUserId as findAccountByAuthUserIdSql,
  findAccountByEmail as findAccountByEmailSql,
  findAccountById as findAccountByIdSql,
  findAccountByIdOrUsername as findAccountByIdOrUsernameSql,
  findAccountByUsername as findAccountByUsernameSql,
  findAccountsByIdsJson as findAccountsByIdsJsonSql,
  findAccountsByUsernamesJson as findAccountsByUsernamesJsonSql,
  insertAccount as insertAccountSql,
  listDirectoryAccountsByActive as listDirectoryAccountsByActiveSql,
  listDirectoryAccountsByNew as listDirectoryAccountsByNewSql,
  searchAccounts as searchAccountsSql,
  searchFollowedAccounts as searchFollowedAccountsSql,
  setAccountLocked as setAccountLockedSql,
  updateAccountProfile as updateAccountProfileSql,
} from "./generated/prisma/sql";
import { type AdminAccountFilters } from "./account-admin-store";

const CountRow = z.object({ count: z.union([z.number(), z.bigint()]) });
const IdRow = z.object({ id: z.string() });

export const AccountRowSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  access_email: Sensitive.schema(AccessEmail.schema),
  display_name: z.string(),
  locked: z.number(),
  default_post_visibility: z.string(),
  default_quote_policy: z.string(),
  public_key_pem: z.string().min(1),
  private_key_jwk: Sensitive.schema(z.string().min(1)),
  created_at: z.string().min(1),
  bio_text: z.string(),
});

export type AccountRow = z.infer<typeof AccountRowSchema>;

export const parseAccountRow = schemaResult(AccountRowSchema);

export const accountFromRow = (row: AccountRow): Result<LocalAccount, RepositoryError> => {
  const id = AccountId.parse(row.id);
  const username = Username.parse(row.username);
  const createdAt = IsoInstant.parse(row.created_at);
  const visibility = Visibility.fromMastodon(row.default_post_visibility);
  if (id.isErr() || username.isErr() || createdAt.isErr() || visibility.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid account row" });
  }
  return ok({
    kind: "LocalAccount",
    id: id.value,
    username: username.value,
    accessEmail: row.access_email,
    displayName: row.display_name,
    locked: row.locked === 1,
    defaultPostVisibility: visibility.value,
    defaultQuotePolicy: quotePolicyFromSql(row.default_quote_policy),
    publicKeyPem: row.public_key_pem,
    privateKeyJwk: row.private_key_jwk,
    createdAt: createdAt.value,
  });
};

export const findAccountById = async (
  db: D1Database,
  id: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped(db, findAccountByIdSql(id), AccountRowSchema);
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const row = queried.value[0];
  return row === undefined ? ok(undefined) : accountFromRow(row);
};

export const findAccountsByIds = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<Map<string, LocalAccount>, RepositoryError>> => {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (unique.length === 0) {
    return ok(new Map<string, LocalAccount>());
  }
  const queried = await runD1(async () =>
    queryTyped(db, findAccountsByIdsJsonSql(jsonStringArray(unique)), AccountRowSchema),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(
    new Map(
      okValues(queried.value.map((row) => accountFromRow(row))).map((account) => [
        account.id,
        account,
      ]),
    ),
  );
};

export const findAccountByUsername = async (
  db: D1Database,
  username: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped(db, findAccountByUsernameSql(username.toLowerCase()), AccountRowSchema);
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const row = queried.value[0];
  return row === undefined ? ok(undefined) : accountFromRow(row);
};

/** Resolve many local usernames in one (or few chunked) IN queries. */
export const findAccountsByUsernames = async (
  db: D1Database,
  usernames: ReadonlyArray<string>,
): Promise<Result<LocalAccount[], RepositoryError>> => {
  const normalized = [
    ...new Set(
      usernames
        .map((username) => username.trim().toLowerCase())
        .filter((username) => username.length > 0),
    ),
  ];
  if (normalized.length === 0) {
    return ok([]);
  }
  const queried = await runD1(async () =>
    queryTyped(db, findAccountsByUsernamesJsonSql(jsonStringArray(normalized)), AccountRowSchema),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(okValues(queried.value.map((row) => accountFromRow(row))));
};

export const findAccountByEmail = async (
  db: D1Database,
  email: SensitiveValue<AccessEmail>,
): Promise<Result<LocalAccount | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped(db, findAccountByEmailSql(email.reveal()), AccountRowSchema);
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const row = queried.value[0];
  return row === undefined ? ok(undefined) : accountFromRow(row);
};

/** The local account the Better Auth user `authUserId` signs in as. */
export const findAccountByAuthUserId = async (
  db: D1Database,
  authUserId: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> => {
  const queried = await runD1(async () =>
    queryTyped(db, findAccountByAuthUserIdSql(authUserId), AccountRowSchema),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  const row = queried.value[0];
  return row === undefined ? ok(undefined) : accountFromRow(row);
};

/** Whose accounts a local account search lists: anyone's, or those one account follows. */
export type LocalAccountSearchScope =
  | Readonly<{ kind: "Everyone" }>
  | Readonly<{ kind: "FollowedBy"; accountId: string }>;

/**
 * Local accounts whose username or display name contains `query`, by
 * username, leaving out those search may not list (pending approval or
 * suspended), so `offset` counts listed accounts.
 */
export const searchAccounts = async (
  db: D1Database,
  query: string,
  scope: LocalAccountSearchScope,
  limit: number,
  offset: number,
): Promise<Result<LocalAccount[], RepositoryError>> =>
  runD1(async () => {
    const usernameLike = `%${query.toLowerCase()}%`;
    const displayNameLike = `%${query}%`;
    const results = await queryTyped(
      db,
      scope.kind === "Everyone"
        ? searchAccountsSql(usernameLike, displayNameLike, limit, offset)
        : searchFollowedAccountsSql(usernameLike, displayNameLike, scope.accountId, limit, offset),
      AccountRowSchema,
    );
    return results.flatMap((row) => {
      const parsed = accountFromRow(row);
      return parsed.isOk() ? [parsed.value] : [];
    });
  });

/** How many accounts {@link searchAccounts} lists for `query` to everyone. */
export const countSearchAccounts = async (
  db: D1Database,
  query: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      countSearchAccountsSql(`%${query.toLowerCase()}%`, `%${query}%`),
      CountRow,
    );
    return Number(rows[0]?.count ?? 0);
  });

export const insertAccount = async (
  db: D1Database,
  account: LocalAccount,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      insertAccountSql(
        account.id,
        account.username,
        account.accessEmail.reveal(),
        account.displayName,
        account.locked ? 1 : 0,
        visibilitySql(account.defaultPostVisibility),
        quotePolicySql(account.defaultQuotePolicy),
        account.publicKeyPem,
        account.privateKeyJwk.reveal(),
        account.createdAt,
        account.createdAt,
        "",
      ),
    );
  });

export const countAccounts = async (db: D1Database): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, countAccountsSql(), CountRow);
    return Number(rows[0]?.count ?? 0);
  });

export const listDirectoryAccounts = async (
  db: D1Database,
  input: Readonly<{ order: "new" | "active"; limit: number; offset: number }>,
): Promise<Result<LocalAccount[], RepositoryError>> =>
  runD1(async () => {
    const results =
      input.order === "active"
        ? await queryTyped(
            db,
            listDirectoryAccountsByActiveSql(input.limit, input.offset),
            AccountRowSchema,
          )
        : await queryTyped(
            db,
            listDirectoryAccountsByNewSql(input.limit, input.offset),
            AccountRowSchema,
          );
    return okValues(results.map((row) => accountFromRow(row)));
  });

/** Toggle whether the account approves followers by hand. */
export const setAccountLocked = async (
  db: D1Database,
  accountId: string,
  locked: boolean,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await runTyped(db, setAccountLockedSql(locked ? 1 : 0, accountId));
  });
  return written.map(() => undefined);
};

/** Purge a local account; every dependent row cascades from it. */
export const deleteAccount = async (
  db: D1Database,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, deleteAccountSql(id), IdRow);
    return rows.length > 0;
  });

export const STATUS_SQL: Readonly<Record<AdminAccountFilters["status"], string>> = {
  all: "1",
  active: `id NOT IN (SELECT account_id FROM account_moderation WHERE moderation = 'Suspended')`,
  pending: "id IN (SELECT account_id FROM account_flags WHERE pending <> 0)",
  disabled: "id IN (SELECT account_id FROM account_flags WHERE disabled <> 0)",
  silenced: `id IN (SELECT account_id FROM account_moderation WHERE moderation = 'Silenced')`,
  suspended: `id IN (SELECT account_id FROM account_moderation WHERE moderation = 'Suspended')`,
  sensitized: "id IN (SELECT account_id FROM account_flags WHERE sensitized <> 0)",
};

export const findAccountByIdOrUsername = async (
  db: D1Database,
  idOrUsername: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> => {
  const queried = await runD1(async () =>
    queryTyped(
      db,
      findAccountByIdOrUsernameSql(idOrUsername, idOrUsername.toLowerCase()),
      AccountRowSchema,
    ),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  const row = queried.value[0];
  return row === undefined ? ok(undefined) : accountFromRow(row);
};

export const updateAccountProfile = async (
  db: D1Database,
  accountId: string,
  displayName: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, updateAccountProfileSql(displayName, nowIso(), accountId));
  });

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([AccountRowSchema]);
