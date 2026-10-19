import { ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import { idCursorFragment, type IdCursor } from "./id-cursor";
import { newEntityId } from "./ids";
import { queryTyped, runTyped } from "./typed-sql";
import {
  deleteCanonicalEmailBlock as deleteCanonicalEmailBlockSql,
  deleteEmailDomainBlock as deleteEmailDomainBlockSql,
  emailDomainAccountHistory as emailDomainAccountHistorySql,
  findCanonicalEmailBlockById as findCanonicalEmailBlockByIdSql,
  findCanonicalEmailBlockByHash as findCanonicalEmailBlockByHashSql,
  findEmailDomainBlockById as findEmailDomainBlockByIdSql,
  findEmailDomainBlockByDomain as findEmailDomainBlockByDomainSql,
  insertCanonicalEmailBlock as insertCanonicalEmailBlockSql,
  insertEmailDomainBlock as insertEmailDomainBlockSql,
} from "./generated/prisma/sql";

export type CanonicalEmailBlock = Readonly<{
  id: string;
  canonicalEmailHash: string;
  createdAt: string;
}>;

export type EmailDomainBlock = Readonly<{
  id: string;
  domain: string;
  createdAt: string;
}>;

/**
 * Mastodon's canonical form: lowercase, the local part loses its dots and any
 * `+tag`, then the address is SHA-256 hashed. Two spellings of one mailbox
 * therefore block each other.
 */
export const canonicalEmailHash = async (email: string): Promise<string> => {
  const [local = "", domain = ""] = email.trim().toLowerCase().split("@", 2);
  const canonicalLocal = (local.split("+", 1)[0] ?? "").replaceAll(".", "");
  const bytes = new TextEncoder().encode(`${canonicalLocal}@${domain}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const canonicalFromRow = (row: {
  id: string;
  canonical_email_hash: string;
  created_at: string;
}): CanonicalEmailBlock => ({
  id: row.id,
  canonicalEmailHash: row.canonical_email_hash,
  createdAt: row.created_at,
});

const domainFromRow = (row: {
  id: string;
  domain: string;
  created_at: string;
}): EmailDomainBlock => ({
  id: row.id,
  domain: row.domain,
  createdAt: row.created_at,
});

export const listCanonicalEmailBlocks = async (
  db: D1Database,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<ReadonlyArray<CanonicalEmailBlock>, RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT id, canonical_email_hash, created_at FROM canonical_email_blocks
         WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(...binds, limit)
      .all();
    return (results ?? []).map((row) => canonicalFromRow(row as never));
  });

export const findCanonicalEmailBlockById = async (
  db: D1Database,
  id: string,
): Promise<Result<CanonicalEmailBlock | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{
      id: string;
      canonical_email_hash: string;
      created_at: string;
    }>(db, findCanonicalEmailBlockByIdSql(id));
    const row = rows[0];
    return row ? canonicalFromRow(row) : undefined;
  });

export const findCanonicalEmailBlockByEmail = async (
  db: D1Database,
  email: string,
): Promise<Result<CanonicalEmailBlock | undefined, RepositoryError>> => {
  const hash = await canonicalEmailHash(email);
  const queried = await runD1(async () =>
    queryTyped<{ id: string; canonical_email_hash: string; created_at: string }>(
      db,
      findCanonicalEmailBlockByHashSql(hash),
    ),
  );
  if (queried.isErr()) {
    return queried.map(() => undefined);
  }
  const row = queried.value[0];
  return ok(row ? canonicalFromRow(row) : undefined);
};

/** Block a canonical email hash; a duplicate hash is refused by the unique index. */
export const insertCanonicalEmailBlock = async (
  db: D1Database,
  hash: string,
): Promise<Result<CanonicalEmailBlock, RepositoryError>> =>
  runD1(async () => {
    const id = newEntityId();
    const createdAt = nowIso();
    await runTyped(db, insertCanonicalEmailBlockSql(id, hash, createdAt));
    return { id, canonicalEmailHash: hash, createdAt };
  });

export const deleteCanonicalEmailBlock = async (
  db: D1Database,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(db, deleteCanonicalEmailBlockSql(id));
    return rows.length > 0;
  });

export const listEmailDomainBlocks = async (
  db: D1Database,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<ReadonlyArray<EmailDomainBlock>, RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT id, domain, created_at FROM email_domain_blocks
         WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(...binds, limit)
      .all();
    return (results ?? []).map((row) => domainFromRow(row as never));
  });

export const findEmailDomainBlockById = async (
  db: D1Database,
  id: string,
): Promise<Result<EmailDomainBlock | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string; domain: string; created_at: string }>(
      db,
      findEmailDomainBlockByIdSql(id),
    );
    const row = rows[0];
    return row ? domainFromRow(row) : undefined;
  });

export const insertEmailDomainBlock = async (
  db: D1Database,
  domain: string,
): Promise<Result<EmailDomainBlock, RepositoryError>> =>
  runD1(async () => {
    const id = newEntityId();
    const createdAt = nowIso();
    await runTyped(db, insertEmailDomainBlockSql(id, domain, createdAt));
    return { id, domain, createdAt };
  });

export const deleteEmailDomainBlock = async (
  db: D1Database,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(db, deleteEmailDomainBlockSql(id));
    return rows.length > 0;
  });

/**
 * True when this address may not create a new account: its domain is blocked,
 * or its canonical hash was blocked after a moderation action.
 */
export const isRegistrationBlocked = async (
  db: D1Database,
  email: string,
): Promise<Result<boolean, RepositoryError>> => {
  const [local, domain] = email.trim().toLowerCase().split("@", 2);
  if (!local || !domain) {
    return ok(false);
  }
  const blockedDomain = await runD1(async () =>
    queryTyped<{ id: string }>(db, findEmailDomainBlockByDomainSql(domain)),
  );
  if (blockedDomain.isErr()) {
    return blockedDomain.map(() => false);
  }
  if (blockedDomain.value.length > 0) {
    return ok(true);
  }
  const canonical = await findCanonicalEmailBlockByEmail(db, email);
  if (canonical.isErr()) {
    return canonical.map(() => false);
  }
  return ok(canonical.value !== undefined);
};

/** Accounts created per day for a blocked domain, newest first (Mastodon: 5 days). */
export const emailDomainHistory = async (
  db: D1Database,
  domain: string,
  days: number = 5,
): Promise<
  Result<ReadonlyArray<{ day: string; accounts: string; uses: string }>, RepositoryError>
> =>
  runD1(async () => {
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const since = new Date(startOfToday.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    const counts = new Map<string, number>();
    const rows = await queryTyped<{ day: string; accounts: number }>(
      db,
      emailDomainAccountHistorySql(domain, since.toISOString()),
    );
    for (const row of rows) {
      counts.set(row.day, Number(row.accounts));
    }
    const history: Array<{ day: string; accounts: string; uses: string }> = [];
    for (let index = 0; index < days; index += 1) {
      const day = new Date(since.getTime() + index * 24 * 60 * 60 * 1000);
      const key = day.toISOString().slice(0, 10);
      history.push({
        day: String(Math.floor(day.getTime() / 1000)),
        accounts: String(counts.get(key) ?? 0),
        uses: "0",
      });
    }
    return history.toReversed();
  });
