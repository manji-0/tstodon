import { Hostname } from "@tstodon/domain";
import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { parseRows, runD1, toRepositoryError, type RepositoryError } from "./d1";
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
 * Whether the account blocks either host of the remote actor: its account
 * domain (`remote_actors.host`, the WebFinger domain) or its URI's host
 * (`uri_host`), as an instance rule matches and as the block's severance and
 * the timelines do. Mastodon matches `account.domain` only; matching both
 * only ever blocks more, and a block made before the account domain was
 * confirmed keeps working. An actor not cached has neither.
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

const PreviewCountsRow = z.object({ following_count: z.number(), followers_count: z.number() });

export type DomainBlockPreview = z.infer<typeof PreviewCountsRow>;

/**
 * How many of the domain's actors the account follows and how many follow
 * it: the accepted follows a block of the domain would sever, as Mastodon's
 * `DomainBlockPreviewPresenter` counts them. An actor is on the domain as
 * the block matches it, by its account domain or its URI's host.
 */
export const previewDomainBlock = async (
  db: D1Database,
  accountId: string,
  domain: Hostname,
): Promise<Result<DomainBlockPreview, RepositoryError>> => {
  const counted = await runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM outbound_follows o
            JOIN remote_actors r ON r.actor_uri = o.actor_uri
            WHERE o.account_id = ?1 AND o.state = 'Accepted' AND ?2 IN (r.host, r.uri_host))
             AS following_count,
           (SELECT COUNT(*) FROM remote_follows f
            JOIN remote_actors r ON r.actor_uri = f.remote_actor_uri
            WHERE f.target_account_id = ?1 AND f.follow_kind = 'Accepted'
              AND ?2 IN (r.host, r.uri_host))
             AS followers_count`,
      )
      .bind(accountId, domain)
      .all();
    return parseRows(PreviewCountsRow, results);
  });
  if (counted.isErr()) {
    return err(counted.error);
  }
  const [row] = counted.value;
  return row ? ok(row) : err(toRepositoryError("invalid row"));
};
