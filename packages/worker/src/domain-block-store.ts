import { Hostname } from "@tstodon/domain";
import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import {
  deleteAccountDomainBlock as deleteAccountDomainBlockSql,
  findActorDomainBlock as findActorDomainBlockSql,
  findAccountDomainBlock as findAccountDomainBlockSql,
  insertAccountDomainBlock as insertAccountDomainBlockSql,
  listAccountDomainBlocks as listAccountDomainBlocksSql,
} from "./generated/prisma/sql";
import { queryTyped, runTyped } from "./typed-sql";

const DomainRow = z.object({ domain: z.string() });

const hostOfRow = (row: z.infer<typeof DomainRow>): Hostname => Hostname.ofAuthority(row.domain);

/** Block `domain` for the account. Answers whether the block is new. */
export const blockDomain = async (
  db: D1Database,
  accountId: string,
  domain: Hostname,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const written = await runTyped(db, insertAccountDomainBlockSql(accountId, domain, nowIso()));
    return written.meta.changes > 0;
  });

export const unblockDomain = async (
  db: D1Database,
  accountId: string,
  domain: Hostname,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, deleteAccountDomainBlockSql(accountId, domain), DomainRow);
    return rows.length > 0;
  });

export const listBlockedDomains = async (
  db: D1Database,
  accountId: string,
): Promise<Result<Hostname[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listAccountDomainBlocksSql(accountId), DomainRow);
    return rows.map(hostOfRow);
  });

export const isDomainBlocked = async (
  db: D1Database,
  accountId: string,
  domain: Hostname,
): Promise<Result<boolean, RepositoryError>> => {
  const found = await runD1(async () => {
    const rows = await queryTyped(db, findAccountDomainBlockSql(accountId, domain), DomainRow);
    return rows.length > 0;
  });
  if (found.isErr()) {
    return err(found.error);
  }
  return ok(found.value);
};

/**
 * Whether the account blocks the remote actor's account domain. The domain is
 * `remote_actors.host`, the WebFinger domain, as Mastodon matches
 * `account.domain`, and as the block's severance and the timelines do; never
 * the host of the actor URI, which can differ. An actor not cached has none.
 */
export const isActorDomainBlocked = (
  db: D1Database,
  accountId: string,
  actorUri: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findActorDomainBlockSql(accountId, actorUri), DomainRow);
    return rows.length > 0;
  });
