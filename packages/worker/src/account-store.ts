import {
  AccessEmail,
  AccountId,
  IsoInstant,
  LocalAccount,
  Registration,
  Username,
  Visibility,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { nowInstant, nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import { generateAccountKeys } from "./keys";
import { newEntityId } from "./ids";
import { quotePolicyFromSql, quotePolicySql, visibilitySql } from "./sql-enums";

export type AccountRow = {
  id: string;
  username: string;
  access_email: string;
  display_name: string;
  locked: number;
  default_post_visibility: string;
  default_quote_policy: string;
  public_key_pem: string;
  private_key_jwk: string;
  created_at: string;
  bio_text: string;
};

const accountSelect = `id, username, access_email, display_name, locked, default_post_visibility, default_quote_policy, public_key_pem, private_key_jwk, created_at, COALESCE(bio_text, '') AS bio_text`;

export const accountFromRow = (
  row: AccountRow,
): Result<LocalAccount, RepositoryError> => {
  const id = AccountId.parse(row.id);
  const username = Username.parse(row.username);
  const email = AccessEmail.parse(row.access_email);
  const createdAt = IsoInstant.parse(row.created_at);
  const visibility = Visibility.fromMastodon(row.default_post_visibility);
  if (id.isErr() || username.isErr() || email.isErr() || createdAt.isErr() || visibility.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid account row" });
  }
  const parsed = LocalAccount.schema.safeParse({
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
  return parsed.success
    ? ok(parsed.data)
    : err({ kind: "RepositoryError", message: "account schema rejected row" });
};

export const findAccountById = async (
  db: D1Database,
  id: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(`SELECT ${accountSelect} FROM accounts WHERE id = ?`)
      .bind(id)
      .first<AccountRow>();
    if (!row) {
      return undefined;
    }
    const parsed = accountFromRow(row);
    if (parsed.isErr()) {
      throw new Error(parsed.error.message);
    }
    return parsed.value;
  });

export const findAccountByUsername = async (
  db: D1Database,
  username: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(`SELECT ${accountSelect} FROM accounts WHERE username = ?`)
      .bind(username.toLowerCase())
      .first<AccountRow>();
    if (!row) {
      return undefined;
    }
    const parsed = accountFromRow(row);
    if (parsed.isErr()) {
      throw new Error(parsed.error.message);
    }
    return parsed.value;
  });

export const findAccountByEmail = async (
  db: D1Database,
  email: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(`SELECT ${accountSelect} FROM accounts WHERE access_email = ?`)
      .bind(email.toLowerCase())
      .first<AccountRow>();
    if (!row) {
      return undefined;
    }
    const parsed = accountFromRow(row);
    if (parsed.isErr()) {
      throw new Error(parsed.error.message);
    }
    return parsed.value;
  });

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
      .all<AccountRow>();
    return (results ?? []).flatMap((row) => {
      const parsed = accountFromRow(row);
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

export const countAccounts = async (
  db: D1Database,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(`SELECT COUNT(*) AS count FROM accounts`)
      .first<{ count: number }>();
    return row?.count ?? 0;
  });

export const accountCounts = async (
  db: D1Database,
  accountId: string,
): Promise<
  Result<
    Readonly<{ followers: number; following: number; statuses: number }>,
    RepositoryError
  >
> =>
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
      .prepare(
        `UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(displayName, nowIso(), accountId)
      .run();
  });
