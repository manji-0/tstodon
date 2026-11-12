import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import { queryTyped } from "./typed-sql";
import { accountStatsByIdsJson as accountStatsByIdsJsonSql } from "./generated/prisma/sql";

export type AccountCounts = Readonly<{ followers: number; following: number; statuses: number }>;

const NO_COUNTS: AccountCounts = { followers: 0, following: 0, statuses: 0 };

const AccountStatsRow = z.object({
  account_id: z.string(),
  statuses_count: z.number(),
  followers_count: z.number(),
  following_count: z.number(),
});

export const accountCounts = async (
  db: D1Database,
  accountId: string,
): Promise<Result<AccountCounts, RepositoryError>> =>
  (await accountCountsByIds(db, [accountId])).map((counts) => counts.get(accountId) ?? NO_COUNTS);

/** The counters triggers keep in `account_stats` (migration 0137); an account without a row has none. */
export const accountCountsByIds = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Result<Map<string, AccountCounts>, RepositoryError>> => {
  const unique = [...new Set(accountIds.filter((id) => id.length > 0))];
  if (unique.length === 0) {
    return ok(new Map<string, AccountCounts>());
  }
  const rows = await runD1(() =>
    queryTyped(db, accountStatsByIdsJsonSql(jsonStringArray(unique)), AccountStatsRow),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  const byId = new Map(rows.value.map((row) => [row.account_id, row]));
  return ok(
    new Map(
      unique.map((id): [string, AccountCounts] => {
        const row = byId.get(id);
        return [
          id,
          row
            ? {
                followers: row.followers_count,
                following: row.following_count,
                statuses: row.statuses_count,
              }
            : NO_COUNTS,
        ];
      }),
    ),
  );
};
