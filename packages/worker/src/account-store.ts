import {
  AccessEmail,
  AccountId,
  IsoInstant,
  LocalAccount,
  Registration,
  Username,
  Visibility,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import { markAccountPending } from "./account-flag-store";
import { idCursorFragment, type IdCursor } from "./id-cursor";
import { nowInstant, nowIso } from "./clock";
import { jsonStringArray, runD1, runD1Batch, type RepositoryError } from "./d1";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import { generateAccountKeys } from "./keys";
import { newEntityId } from "./ids";
import { AccountRowSchema, toRepositoryError } from "./schemas";
import { quotePolicyFromSql, quotePolicySql, visibilitySql } from "./sql-enums";
import {
  accountCounts as accountCountsSql,
  countAccounts as countAccountsSql,
  countFollowersByAccountIdsJson as countFollowersByAccountIdsJsonSql,
  countFollowingByAccountIdsJson as countFollowingByAccountIdsJsonSql,
  countStatusesByAccountIdsJson as countStatusesByAccountIdsJsonSql,
  deleteAccount as deleteAccountSql,
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

export type AccountRow = z.infer<typeof AccountRowSchema>;

const parseAccountRow = schemaResult(AccountRowSchema);
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

export const provisionAccountFromEmail = async (
  db: D1Database,
  rawEmail: string,
  options: Readonly<{ pending?: boolean }> = {},
): Promise<Result<LocalAccount, RepositoryError>> => {
  const existing = await findAccountByEmail(db, rawEmail);
  if (existing.isErr()) {
    return err(existing.error);
  }
  if (existing.value) {
    return ok(existing.value);
  }
  const email = AccessEmail.parse(rawEmail);
  if (email.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid email" });
  }
  const baseUsername = Username.deriveFromEmail(email.value, false);
  if (baseUsername.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid username" });
  }
  const taken = await findAccountByUsername(db, baseUsername.value);
  if (taken.isErr()) {
    return err(taken.error);
  }
  const username = taken.value
    ? Username.deriveFromEmail(email.value, true)
    : ok(baseUsername.value);
  if (username.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid username" });
  }
  const keys = await generateAccountKeys();
  const id = AccountId.parse(newEntityId());
  if (id.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid id" });
  }
  const registering = Registration.register(
    { kind: "IntentValidated", username: username.value, email: email.value },
    id.value,
    keys,
  );
  const account = LocalAccount.provision(registering, nowInstant());
  const inserted = await insertAccount(db, account);
  if (inserted.isErr()) {
    return err(inserted.error);
  }
  if (options.pending) {
    // Registrations that need approval start unsearchable until an admin acts.
    const marked = await markAccountPending(db, account.id);
    if (marked.isErr()) {
      return err(marked.error);
    }
  }
  return ok(account);
};

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

/**
 * Mastodon's admin account filters. `origin`/`status` are the translated form
 * (`local`/`active` by default); the text filters are case-insensitive
 * substrings. States this instance cannot hold (`remote`, `disabled`,
 * `byDomain`, `ip`, `staff`) match nothing rather than being ignored.
 */
export type AdminAccountFilters = Readonly<{
  origin: "local" | "remote";
  status: "active" | "pending" | "disabled" | "silenced" | "suspended" | "sensitized";
  username?: string | undefined;
  displayName?: string | undefined;
  email?: string | undefined;
  byDomain?: string | undefined;
  ip?: string | undefined;
  staff?: boolean | undefined;
  cursor?: IdCursor | undefined;
  limit: number;
  offset: number;
}>;

const STATUS_SQL: Readonly<Record<AdminAccountFilters["status"], string>> = {
  active: `id NOT IN (SELECT account_id FROM account_moderation WHERE moderation = 'Suspended')`,
  pending: "id IN (SELECT account_id FROM account_flags WHERE pending <> 0)",
  disabled: "0",
  silenced: `id IN (SELECT account_id FROM account_moderation WHERE moderation = 'Silenced')`,
  suspended: `id IN (SELECT account_id FROM account_moderation WHERE moderation = 'Suspended')`,
  sensitized: "id IN (SELECT account_id FROM account_flags WHERE sensitized <> 0)",
};

export const listAdminAccounts = async (
  db: D1Database,
  filters: AdminAccountFilters,
): Promise<Result<LocalAccount[], RepositoryError>> =>
  runD1(async () => {
    const conditions = [STATUS_SQL[filters.status]];
    const binds: Array<string | number> = [];
    if (filters.origin === "remote") {
      // Every account in this table is local.
      conditions.push("0");
    }
    if (filters.username) {
      conditions.push("username LIKE ?");
      binds.push(`%${filters.username}%`);
    }
    if (filters.displayName) {
      conditions.push("display_name LIKE ?");
      binds.push(`%${filters.displayName}%`);
    }
    if (filters.email) {
      conditions.push("access_email LIKE ?");
      binds.push(`${filters.email.toLowerCase()}%`);
    }
    if (filters.byDomain || filters.ip || filters.staff) {
      // No domain (local only), no recorded IPs, no staff accounts.
      conditions.push("0");
    }
    // Mastodon pages this list by account id; `offset` stays as an
    // undocumented fallback for callers that still use it.
    const { where, order, binds: cursorBinds } = idCursorFragment(filters.cursor);
    const pagination = filters.cursor === undefined ? "LIMIT ? OFFSET ?" : `LIMIT ?`;
    const { results } = await db
      .prepare(
        `SELECT id, username, access_email, display_name, locked, default_post_visibility, default_quote_policy,
                public_key_pem, private_key_jwk, created_at, COALESCE(bio_text, '') AS bio_text
         FROM accounts
         WHERE ${conditions.join(" AND ")} ${where}
         ${order}
         ${pagination}`,
      )
      .bind(
        ...binds,
        ...cursorBinds,
        filters.limit,
        ...(filters.cursor === undefined ? [filters.offset] : []),
      )
      .all();
    const accounts: LocalAccount[] = [];
    for (const raw of results ?? []) {
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

export type AccountCounts = Readonly<{ followers: number; following: number; statuses: number }>;

export const accountCounts = async (
  db: D1Database,
  accountId: string,
): Promise<Result<AccountCounts, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, accountCountsSql(accountId));
    const row = rows[0];
    return {
      followers: Number(row?.followers ?? 0),
      following: Number(row?.following ?? 0),
      statuses: Number(row?.statuses ?? 0),
    };
  });

export const accountCountsByIds = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Result<Map<string, AccountCounts>, RepositoryError>> => {
  const unique = [...new Set(accountIds.filter((id) => id.length > 0))];
  const counts = new Map<string, AccountCounts>();
  for (const id of unique) {
    counts.set(id, { followers: 0, following: 0, statuses: 0 });
  }
  if (unique.length === 0) {
    return ok(counts);
  }
  const idsJson = jsonStringArray(unique);
  const queried = await runD1Batch(db, [
    d1PrepareTyped(db, countFollowersByAccountIdsJsonSql(idsJson)),
    d1PrepareTyped(db, countFollowingByAccountIdsJsonSql(idsJson)),
    d1PrepareTyped(db, countStatusesByAccountIdsJsonSql(idsJson)),
  ]);
  if (queried.isErr()) {
    return err(queried.error);
  }
  const apply = (
    result: D1Result | undefined,
    key: "followers" | "following" | "statuses",
  ): void => {
    for (const row of (result?.results ?? []) as Array<{ account_id: string; count: number }>) {
      const current = counts.get(row.account_id) ?? {
        followers: 0,
        following: 0,
        statuses: 0,
      };
      counts.set(row.account_id, { ...current, [key]: row.count });
    }
  };
  apply(queried.value[0], "followers");
  apply(queried.value[1], "following");
  apply(queried.value[2], "statuses");
  return ok(counts);
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
