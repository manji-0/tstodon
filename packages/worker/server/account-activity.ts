import { z } from "zod";
import type { Result } from "neverthrow";
import { jsonStringArray, parseRows, runD1, type RepositoryError } from "./d1";
import {
  countActiveAccountsSince,
  findAccountSignIn,
  listAccountIpsByAccountIdsJson,
  listAllAccountIps,
  recordAccountActivityDay,
  recordAccountIp,
  touchAccountSignIn,
} from "./generated/prisma/sql";
import { clientIp } from "./ip-access";
import { queryTyped, runTypedBatch } from "./typed-sql";

/**
 * Minimal activity tracking (migration 0124): the UTC days a local account
 * made an authenticated request, for the `active_users` measure and the
 * retention cohorts, and the addresses it used, for `Admin::Account#ips`
 * and the admin `ip` filter. Mastodon keeps the first in Redis and the
 * second in `user_ips`. Also the account's sign-in time (migration 0172),
 * Mastodon's `current_sign_in_at`.
 *
 * Each (account, day, address) is written at most once per isolate, and the
 * sign-in time only when it is due, so an active account costs one small
 * batch per isolate per day, not a write per request. A failed write is
 * dropped: tracking never fails the request.
 */

const MAX_REMEMBERED = 10_000;
const remembered = new Set<string>();

const DAY_MS = 86_400_000;

const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * How long a user counts as signed in recently, Mastodon's
 * `User::ACTIVE_DURATION`, unless the `USER_ACTIVE_DAYS` var sets it.
 */
const DEFAULT_USER_ACTIVE_DAYS = 7;

/** The earliest instant a `Date` holds; a longer window reaches back to it. */
const EARLIEST_DATE_MS = -8.64e15;

/**
 * The earliest sign-in time that counts as signed in recently
 * (`User.signed_in_recently`): `USER_ACTIVE_DAYS` (a whole number of days)
 * before `now`.
 */
export const signedInRecentlySince = (
  env: Readonly<{ USER_ACTIVE_DAYS?: string }>,
  now: Date = new Date(),
): string => {
  const raw = (env.USER_ACTIVE_DAYS ?? "").trim();
  const days = /^\d+$/.test(raw) ? Number(raw) : DEFAULT_USER_ACTIVE_DAYS;
  return new Date(Math.max(now.getTime() - days * DAY_MS, EARLIEST_DATE_MS)).toISOString();
};

/**
 * Mastodon's `UserTrackingConcern::SIGN_IN_UPDATE_FREQUENCY`: a request
 * moves the sign-in time only when it is older than this.
 */
const SIGN_IN_UPDATE_FREQUENCY_MS = DAY_MS;

/**
 * Each account's sign-in time (epoch ms) as this isolate last read it. The
 * stored time only moves forward, so one read earlier never hides a due
 * update.
 */
const signIns = new Map<string, number>();

/**
 * Mastodon's streaming server is not Rails, so a stream moves no sign-in
 * time: `UserTrackingConcern` runs on Rails requests only.
 */
const isStreaming = (request: Request): boolean => {
  const path = new URL(request.url).pathname;
  return path === "/api/v1/streaming" || path.startsWith("/api/v1/streaming/");
};

const signInDue = (accountId: string, now: Date, signedInAt: Date | undefined): boolean => {
  const known = signIns.get(accountId);
  return (
    known === undefined ||
    known < now.getTime() - SIGN_IN_UPDATE_FREQUENCY_MS ||
    (signedInAt !== undefined && signedInAt.getTime() > known)
  );
};

const SignInRow = z.object({ current_sign_in_at: z.string().nullable() });

/**
 * Record an authenticated request by `accountId` at `now`. `signedInAt` is
 * when the browser session's sign-in happened, for a request that has one.
 */
export const recordAccountActivity = async (
  db: D1Database,
  accountId: string,
  request: Request,
  now: Date = new Date(),
  signedInAt?: Date,
): Promise<void> => {
  const day = utcDay(now);
  const ip = clientIp(request);
  const key = `${day}|${accountId}|${ip ?? ""}`;
  const dayDue = !remembered.has(key);
  const signInWanted = !isStreaming(request) && signInDue(accountId, now, signedInAt);
  if (!dayDue && !signInWanted) {
    return;
  }
  if (remembered.size >= MAX_REMEMBERED) {
    remembered.clear();
  }
  if (signIns.size >= MAX_REMEMBERED) {
    signIns.clear();
  }
  remembered.add(key);
  // Taken before the write, so requests arriving together send it once.
  const knownSignIn = signIns.get(accountId);
  if (signInWanted) {
    signIns.set(accountId, Math.max(now.getTime(), signedInAt?.getTime() ?? 0));
  }
  const statements = [
    ...(dayDue ? [recordAccountActivityDay(accountId, day)] : []),
    ...(dayDue && ip !== undefined ? [recordAccountIp(accountId, ip, now.toISOString())] : []),
    ...(signInWanted
      ? [
          touchAccountSignIn(
            accountId,
            now.toISOString(),
            new Date(now.getTime() - SIGN_IN_UPDATE_FREQUENCY_MS).toISOString(),
            signedInAt?.toISOString() ?? "",
          ),
          findAccountSignIn(accountId),
        ]
      : []),
  ];
  const written = await runTypedBatch(db, statements);
  if (written.isErr()) {
    remembered.delete(key);
    if (signInWanted && knownSignIn === undefined) {
      signIns.delete(accountId);
    } else if (signInWanted && knownSignIn !== undefined) {
      signIns.set(accountId, knownSignIn);
    }
    return;
  }
  const [stored] = signInWanted ? parseRows(SignInRow, written.value.at(-1)?.results) : [];
  if (stored?.current_sign_in_at) {
    signIns.set(accountId, Date.parse(stored.current_sign_in_at));
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
