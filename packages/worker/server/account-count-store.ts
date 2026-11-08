import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, parseRows, type RepositoryError, runD1, runD1Batch } from "./d1";
import { d1PrepareTyped, queryTyped } from "./typed-sql";
import {
  accountCounts as accountCountsSql,
  countFollowersByAccountIdsJson as countFollowersByAccountIdsJsonSql,
  countFollowingByAccountIdsJson as countFollowingByAccountIdsJsonSql,
  countStatusesByAccountIdsJson as countStatusesByAccountIdsJsonSql,
} from "./generated/prisma/sql";

const CountsRowSchema = z.object({
  followers: z.union([z.number(), z.bigint()]),
  following: z.union([z.number(), z.bigint()]),
  statuses: z.union([z.number(), z.bigint()]),
});

export type AccountCounts = Readonly<{ followers: number; following: number; statuses: number }>;

export const accountCounts = async (
  db: D1Database,
  accountId: string,
): Promise<Result<AccountCounts, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, accountCountsSql(accountId), CountsRowSchema);
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
  if (unique.length === 0) {
    return ok(new Map<string, AccountCounts>());
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
  const AccountCountRowSchema = z.object({ account_id: z.string(), count: z.number() });
  const countsOf = (result: D1Result | undefined): ReadonlyMap<string, number> =>
    new Map(
      parseRows(AccountCountRowSchema, result?.results).map((row) => [row.account_id, row.count]),
    );
  const [followers, following, statuses] = queried.value.map(countsOf);
  return ok(
    new Map(
      unique.map((id) => [
        id,
        {
          followers: followers?.get(id) ?? 0,
          following: following?.get(id) ?? 0,
          statuses: statuses?.get(id) ?? 0,
        },
      ]),
    ),
  );
};
