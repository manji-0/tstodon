import {
  AccessEmail,
  AccountId,
  IsoInstant,
  LocalAccount,
  Username,
  Visibility,
} from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import { toRepositoryError } from "./d1";
import { quotePolicyFromSql, quotePolicySql, visibilitySql } from "./sql-enums";
import {
  countAccounts as countAccountsSql,
  deleteAccount as deleteAccountSql,
  findAccountByAuthUserId as findAccountByAuthUserIdSql,
  findAccountByEmail as findAccountByEmailSql,
  findAccountById as findAccountByIdSql,
  findAccountByUsername as findAccountByUsernameSql,
  findAccountsByIdsJson as findAccountsByIdsJsonSql,
  findAccountsByUsernamesJson as findAccountsByUsernamesJsonSql,
  insertAccount as insertAccountSql,
  listDirectoryAccountsByActive as listDirectoryAccountsByActiveSql,
  listDirectoryAccountsByNew as listDirectoryAccountsByNewSql,
  searchAccounts as searchAccountsSql,
  setAccountLocked as setAccountLockedSql,
  updateAccountProfile as updateAccountProfileSql,
} from "./generated/prisma/sql";
import { type AdminAccountFilters } from "./account-admin-store";

export const AccountRowSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  access_email: z.string().min(1),
  display_name: z.string(),
  locked: z.number(),
  default_post_visibility: z.string(),
  default_quote_policy: z.string(),
  public_key_pem: z.string().min(1),
  private_key_jwk: z.string().min(1),
  created_at: z.string().min(1),
  bio_text: z.string(),
});

export type AccountRow = z.infer<typeof AccountRowSchema>;

export const parseAccountRow = schemaResult(AccountRowSchema);

const parseLocalAccount = schemaResult(LocalAccount.schema);

export const accountFromRow = (row: AccountRow): Result<LocalAccount, RepositoryError> => {
  const id = AccountId.parse(row.id);
  const username = Username.parse(row.username);
  const email = AccessEmail.parse(row.access_email);
  const createdAt = IsoInstant.parse(row.created_at);
  const visibility = Visibility.fromMastodon(row.default_post_visibility);
  if (id.isErr() || username.isErr() || email.isErr() || createdAt.isErr() || visibility.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid account row" });
  }
  const parsed = parseLocalAccount({
    kind: "LocalAccount",
    id: id.value,
    username: username.value,
    accessEmail: email.value,
    displayName: row.display_name,
    locked: row.locked === 1,
    defaultPostVisibility: visibility.value,
    defaultQuotePolicy: quotePolicyFromSql(row.default_quote_policy),
    publicKeyPem: row.public_key_pem,
    privateKeyJwk: row.private_key_jwk,
    createdAt: createdAt.value,
  });
  return parsed.mapErr(() => toRepositoryError("account schema rejected row"));
};

export const findAccountById = async (
  db: D1Database,
  id: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped(db, findAccountByIdSql(id));
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const raw = queried.value[0];
  if (!raw) {
    return ok(undefined);
  }
  const row = parseAccountRow(raw);
  if (row.isErr()) {
    return err(toRepositoryError("invalid account row"));
  }
  return accountFromRow(row.value);
};

export const findAccountsByIds = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<Map<string, LocalAccount>, RepositoryError>> => {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  const accounts = new Map<string, LocalAccount>();
  if (unique.length === 0) {
    return ok(accounts);
  }
  const queried = await runD1(async () =>
    queryTyped(db, findAccountsByIdsJsonSql(jsonStringArray(unique))),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  for (const raw of queried.value) {
    const row = parseAccountRow(raw);
    if (row.isErr()) {
      continue;
    }
    const account = accountFromRow(row.value);
    if (account.isOk()) {
      accounts.set(account.value.id, account.value);
    }
  }
  return ok(accounts);
};

export const findAccountByUsername = async (
  db: D1Database,
  username: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped(db, findAccountByUsernameSql(username.toLowerCase()));
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const raw = queried.value[0];
  if (!raw) {
    return ok(undefined);
  }
  const row = parseAccountRow(raw);
  if (row.isErr()) {
    return err(toRepositoryError("invalid account row"));
  }
  return accountFromRow(row.value);
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
  const accounts: LocalAccount[] = [];
  const queried = await runD1(async () =>
    queryTyped(db, findAccountsByUsernamesJsonSql(jsonStringArray(normalized))),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  for (const raw of queried.value) {
    const row = parseAccountRow(raw);
    if (row.isErr()) {
      continue;
    }
    const parsed = accountFromRow(row.value);
    if (parsed.isOk()) {
      accounts.push(parsed.value);
    }
  }
  return ok(accounts);
};

export const findAccountByEmail = async (
  db: D1Database,
  email: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped(db, findAccountByEmailSql(email.toLowerCase()));
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const raw = queried.value[0];
  if (!raw) {
    return ok(undefined);
  }
  const row = parseAccountRow(raw);
  if (row.isErr()) {
    return err(toRepositoryError("invalid account row"));
  }
  return accountFromRow(row.value);
};

/** The local account the Better Auth user `authUserId` signs in as. */
export const findAccountByAuthUserId = async (
  db: D1Database,
  authUserId: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> => {
  const queried = await runD1(async () => queryTyped(db, findAccountByAuthUserIdSql(authUserId)));
  if (queried.isErr()) {
    return err(queried.error);
  }
  const raw = queried.value[0];
  if (!raw) {
    return ok(undefined);
  }
  const row = parseAccountRow(raw);
  if (row.isErr()) {
    return err(toRepositoryError("invalid account row"));
  }
  return accountFromRow(row.value);
};

export const searchAccounts = async (
  db: D1Database,
  query: string,
  limit: number,
  offset: number = 0,
): Promise<Result<LocalAccount[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(
      db,
      searchAccountsSql(`%${query.toLowerCase()}%`, `%${query}%`, limit, offset),
    );
    return results.flatMap((raw) => {
      const row = parseAccountRow(raw);
      if (row.isErr()) {
        return [];
      }
      const parsed = accountFromRow(row.value);
      return parsed.isOk() ? [parsed.value] : [];
    });
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
        account.accessEmail.unwrap(),
        account.displayName,
        account.locked ? 1 : 0,
        visibilitySql(account.defaultPostVisibility),
        quotePolicySql(account.defaultQuotePolicy),
        account.publicKeyPem,
        account.privateKeyJwk.unwrap(),
        account.createdAt,
        account.createdAt,
        "",
      ),
    );
  });

export const countAccounts = async (db: D1Database): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ count: number | bigint }>(db, countAccountsSql());
    return Number(rows[0]?.count ?? 0);
  });

export const listDirectoryAccounts = async (
  db: D1Database,
  input: Readonly<{ order: "new" | "active"; limit: number; offset: number }>,
): Promise<Result<LocalAccount[], RepositoryError>> =>
  runD1(async () => {
    const results =
      input.order === "active"
        ? await queryTyped(db, listDirectoryAccountsByActiveSql(input.limit, input.offset))
        : await queryTyped(db, listDirectoryAccountsByNewSql(input.limit, input.offset));
    const accounts: LocalAccount[] = [];
    for (const raw of results) {
      const row = parseAccountRow(raw);
      if (row.isErr()) {
        continue;
      }
      const account = accountFromRow(row.value);
      if (account.isOk()) {
        accounts.push(account.value);
      }
    }
    return accounts;
  });

/** Toggle whether the account approves followers by hand. */
export const setAccountLocked = async (
  db: D1Database,
  accountId: string,
  locked: boolean,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await queryTyped(db, setAccountLockedSql(locked ? 1 : 0, accountId));
  });
  return written.map(() => undefined);
};

/** Purge a local account; every dependent row cascades from it. */
export const deleteAccount = async (
  db: D1Database,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(db, deleteAccountSql(id));
    return rows.length > 0;
  });

export const STATUS_SQL: Readonly<Record<AdminAccountFilters["status"], string>> = {
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
  const byId = await findAccountById(db, idOrUsername);
  if (byId.isErr()) {
    return byId;
  }
  if (byId.value) {
    return byId;
  }
  return findAccountByUsername(db, idOrUsername);
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
