import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import {
  deleteAccountDomainBlock as deleteAccountDomainBlockSql,
  findAccountDomainBlock as findAccountDomainBlockSql,
  insertAccountDomainBlock as insertAccountDomainBlockSql,
  listAccountDomainBlocks as listAccountDomainBlocksSql,
} from "./generated/prisma/sql";
import { queryTyped, runTyped } from "./typed-sql";

/** Normalize a user-supplied domain: strip scheme, path, leading `@`, lowercase. */
export const normalizeDomain = (raw: string): string =>
  raw
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();

export const blockDomain = async (
  db: D1Database,
  accountId: string,
  domain: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, insertAccountDomainBlockSql(accountId, domain, nowIso()));
  });

export const unblockDomain = async (
  db: D1Database,
  accountId: string,
  domain: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ domain: string }>(
      db,
      deleteAccountDomainBlockSql(accountId, domain),
    );
    return rows.length > 0;
  });

export const listBlockedDomains = async (
  db: D1Database,
  accountId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ domain: string }>(db, listAccountDomainBlocksSql(accountId));
    return rows.map((row) => row.domain);
  });

export const isDomainBlocked = async (
  db: D1Database,
  accountId: string,
  domain: string,
): Promise<Result<boolean, RepositoryError>> => {
  const found = await runD1(async () => {
    const rows = await queryTyped<{ domain: string }>(
      db,
      findAccountDomainBlockSql(accountId, domain),
    );
    return rows.length > 0;
  });
  if (found.isErr()) {
    return err(found.error);
  }
  return ok(found.value);
};

/** The trailing host of an ActivityPub URI, when it parses. */
export const hostnameOf = (uri: string): string | undefined => {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};
