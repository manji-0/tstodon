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
import { nowInstant, nowIso } from "./clock";
import { chunkArray, runD1, type RepositoryError } from "./d1";
import { generateAccountKeys } from "./keys";
import { newEntityId } from "./ids";
import { AccountRowSchema, toRepositoryError } from "./schemas";
import { quotePolicyFromSql, quotePolicySql, visibilitySql } from "./sql-enums";

export type AccountRow = z.infer<typeof AccountRowSchema>;

const accountSelect = `id, username, access_email, display_name, locked, default_post_visibility, default_quote_policy, public_key_pem, private_key_jwk, created_at, COALESCE(bio_text, '') AS bio_text`;

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
  const queried = await runD1(() =>
    db.prepare(`SELECT ${accountSelect} FROM accounts WHERE id = ?`).bind(id).first(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  if (!queried.value) {
    return ok(undefined);
  }
  const row = parseAccountRow(queried.value);
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
  for (const chunk of chunkArray(unique)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const queried = await runD1(() =>
      db
        .prepare(`SELECT ${accountSelect} FROM accounts WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .all(),
    );
    if (queried.isErr()) {
      return err(queried.error);
    }
    for (const raw of queried.value.results ?? []) {
      const row = parseAccountRow(raw);
      if (row.isErr()) {
        continue;
      }
      const account = accountFromRow(row.value);
      if (account.isOk()) {
        accounts.set(account.value.id, account.value);
      }
    }
  }
  return ok(accounts);
};

export const findAccountByUsername = async (
  db: D1Database,
  username: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> => {
  const queried = await runD1(() =>
    db
      .prepare(`SELECT ${accountSelect} FROM accounts WHERE username = ?`)
      .bind(username.toLowerCase())
      .first(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  if (!queried.value) {
    return ok(undefined);
  }
  const row = parseAccountRow(queried.value);
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
  const chunkSize = 50;
  for (let offset = 0; offset < normalized.length; offset += chunkSize) {
    const chunk = normalized.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const queried = await runD1(() =>
      db
        .prepare(`SELECT ${accountSelect} FROM accounts WHERE username IN (${placeholders})`)
        .bind(...chunk)
        .all(),
    );
    if (queried.isErr()) {
      return err(queried.error);
    }
    for (const raw of queried.value.results ?? []) {
      const row = parseAccountRow(raw);
      if (row.isErr()) {
        continue;
      }
      const parsed = accountFromRow(row.value);
      if (parsed.isOk()) {
        accounts.push(parsed.value);
      }
    }
  }
  return ok(accounts);
};

export const findAccountByEmail = async (
  db: D1Database,
  email: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> => {
  const queried = await runD1(() =>
    db
      .prepare(`SELECT ${accountSelect} FROM accounts WHERE access_email = ?`)
      .bind(email.toLowerCase())
      .first(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  if (!queried.value) {
    return ok(undefined);
  }
  const row = parseAccountRow(queried.value);
  if (row.isErr()) {
    return err(toRepositoryError("invalid account row"));
  }
  return accountFromRow(row.value);
};

export const searchAccounts = async (
  db: D1Database,
  query: string,
  limit: number,
): Promise<Result<LocalAccount[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${accountSelect} FROM accounts WHERE username LIKE ? OR display_name LIKE ? ORDER BY username LIMIT ?`,
      )
      .bind(`%${query.toLowerCase()}%`, `%${query}%`, limit)
      .all();
    return (results ?? []).flatMap((raw) => {
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
    await db
      .prepare(
        `INSERT INTO accounts (
          id, username, access_email, display_name, locked,
          default_post_visibility, default_quote_policy,
          public_key_pem, private_key_jwk, created_at, updated_at, bio_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
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
      )
      .run();
  });

export const provisionAccountFromEmail = async (
  db: D1Database,
  rawEmail: string,
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
  return ok(account);
};

export const countAccounts = async (db: D1Database): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(`SELECT COUNT(*) AS count FROM accounts`)
      .first<{ count: number }>();
    return row?.count ?? 0;
  });

export const listDirectoryAccounts = async (
  db: D1Database,
  input: Readonly<{ order: "new" | "active"; limit: number; offset: number }>,
): Promise<Result<LocalAccount[], RepositoryError>> =>
  runD1(async () => {
    const orderSql =
      input.order === "active"
        ? `(SELECT COUNT(*) FROM statuses s WHERE s.account_id = accounts.id) DESC, accounts.created_at DESC`
        : `accounts.created_at DESC`;
    const { results } = await db
      .prepare(
        `SELECT ${accountSelect} FROM accounts
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`,
      )
      .bind(input.limit, input.offset)
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

export type AccountCounts = Readonly<{
  followers: number;
  following: number;
  statuses: number;
}>;

export const accountCounts = async (
  db: D1Database,
  accountId: string,
): Promise<Result<AccountCounts, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM follows WHERE target_account_id = ? AND kind = 'Accepted') AS followers,
           (SELECT COUNT(*) FROM follows WHERE follower_account_id = ? AND kind = 'Accepted') AS following,
           (SELECT COUNT(*) FROM statuses WHERE account_id = ?) AS statuses`,
      )
      .bind(accountId, accountId, accountId)
      .first<{ followers: number; following: number; statuses: number }>();
    return {
      followers: row?.followers ?? 0,
      following: row?.following ?? 0,
      statuses: row?.statuses ?? 0,
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
  for (const chunk of chunkArray(unique)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const queried = await runD1(() =>
      db.batch([
        db
          .prepare(
            `SELECT target_account_id AS account_id, COUNT(*) AS count
             FROM follows
             WHERE kind = 'Accepted' AND target_account_id IN (${placeholders})
             GROUP BY target_account_id`,
          )
          .bind(...chunk),
        db
          .prepare(
            `SELECT follower_account_id AS account_id, COUNT(*) AS count
             FROM follows
             WHERE kind = 'Accepted' AND follower_account_id IN (${placeholders})
             GROUP BY follower_account_id`,
          )
          .bind(...chunk),
        db
          .prepare(
            `SELECT account_id, COUNT(*) AS count
             FROM statuses
             WHERE account_id IN (${placeholders})
             GROUP BY account_id`,
          )
          .bind(...chunk),
      ]),
    );
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
  }
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
    await db
      .prepare(`UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ?`)
      .bind(displayName, nowIso(), accountId)
      .run();
  });
