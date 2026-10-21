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

export type AccountCounts = Readonly<{ followers: number; following: number; statuses: number }>;

export const accountCounts = async (
  db: D1Database,
  accountId: string,
): Promise<Result<AccountCounts, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, accountCountsSql(accountId));
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
  const counts = new Map<string, AccountCounts>();
  for (const id of unique) {
    counts.set(id, { followers: 0, following: 0, statuses: 0 });
  }
  if (unique.length === 0) {
    return ok(counts);
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
  const apply = (
    result: D1Result | undefined,
    key: "followers" | "following" | "statuses",
  ): void => {
    for (const row of parseRows(AccountCountRowSchema, result?.results)) {
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
  return ok(counts);
};
