import { z } from "zod";
import type { Result } from "neverthrow";
import { jsonStringArray, runD1, type RepositoryError } from "./d1";
import {
  countActiveAccountsSince,
  listAccountIpsByAccountIdsJson,
  listAllAccountIps,
  recordAccountActivityDay,
  recordAccountIp,
} from "./generated/prisma/sql";
import { clientIp } from "./ip-access";
import { queryTyped, runTypedBatch } from "./typed-sql";

/**
 * Minimal activity tracking (migration 0124): the UTC days a local account
 * made an authenticated request, for the `active_users` measure and the
 * retention cohorts, and the addresses it used, for `Admin::Account#ips`
 * and the admin `ip` filter. Mastodon keeps the first in Redis and the
 * second in `user_ips`.
 *
 * Each (account, day, address) is written at most once per isolate, so an
 * active account costs one small batch per isolate per day, not a write per
 * request. A failed write is dropped: tracking never fails the request.
 */

const MAX_REMEMBERED = 10_000;
const remembered = new Set<string>();

const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

export const recordAccountActivity = async (
  db: D1Database,
  accountId: string,
  request: Request,
  now: Date = new Date(),
): Promise<void> => {
  const day = utcDay(now);
  const ip = clientIp(request);
  const key = `${day}|${accountId}|${ip ?? ""}`;
  if (remembered.has(key)) {
    return;
  }
  if (remembered.size >= MAX_REMEMBERED) {
    remembered.clear();
  }
  remembered.add(key);
  const statements = [
    recordAccountActivityDay(accountId, day),
    ...(ip === undefined ? [] : [recordAccountIp(accountId, ip, now.toISOString())]),
  ];
  const written = await runTypedBatch(db, statements);
  if (written.isErr()) {
    remembered.delete(key);
  }
};

/** Record the address an account signed up from (its first `account_ips` row). */
export const recordSignUpIp = async (
  db: D1Database,
  accountId: string,
  request: Request,
): Promise<void> => {
  const ip = clientIp(request);
  if (ip !== undefined) {
    await runTypedBatch(db, [recordAccountIp(accountId, ip, new Date().toISOString())]);
  }
};

const AccountIpRow = z.object({ account_id: z.string(), ip: z.string(), used_at: z.string() });
const AccountIpPairRow = z.object({ account_id: z.string(), ip: z.string() });

export type AccountIp = Readonly<{ ip: string; usedAt: string }>;

/** Each account's addresses, most recently used first. */
export const accountIpsByAccountIds = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, ReadonlyArray<AccountIp>>, RepositoryError>> =>
  runD1(async () => {
    const byAccount = new Map<string, AccountIp[]>();
    if (accountIds.length === 0) {
      return byAccount;
    }
    const rows = await queryTyped(
      db,
      listAccountIpsByAccountIdsJson(jsonStringArray(accountIds)),
      AccountIpRow,
    );
    for (const row of rows) {
      const list = byAccount.get(row.account_id) ?? [];
      list.push({ ip: row.ip, usedAt: row.used_at });
      byAccount.set(row.account_id, list);
    }
    return byAccount;
  });

/** Every recorded (account, address) pair. */
export const allAccountIps = async (
  db: D1Database,
): Promise<Result<ReadonlyArray<Readonly<{ accountId: string; ip: string }>>, RepositoryError>> =>
  runD1(async () =>
    (await queryTyped(db, listAllAccountIps(), AccountIpPairRow)).map((row) => ({
      accountId: row.account_id,
      ip: row.ip,
    })),
  );

const CountRow = z.object({ count: z.union([z.number(), z.bigint()]) });

const DAY_MS = 86_400_000;

/**
 * Local accounts that made an authenticated request on any of the last `days`
 * UTC days, today included. Days before migration 0124 was deployed count no
 * one.
 */
export const countActiveAccounts = async (
  db: D1Database,
  days: number,
  now: Date = new Date(),
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const sinceDay = utcDay(new Date(now.getTime() - (days - 1) * DAY_MS));
    const rows = await queryTyped(db, countActiveAccountsSince(sinceDay), CountRow);
    return Number(rows[0]?.count ?? 0);
  });
