import type { LocalStatus as LocalStatusValue } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import {
  countPinnedStatuses as countPinnedStatusesSql,
  isStatusPinned as isStatusPinnedSql,
  listPinnedStatuses as listPinnedStatusesSql,
  pinStatus as pinStatusSql,
  unpinStatus as unpinStatusSql,
} from "./generated/prisma/sql";
import { hydrateStatusRows } from "./status-store";

export const pinStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, pinStatusSql(accountId, statusId, nowIso()));
  });

export const unpinStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ status_id: string }>(db, unpinStatusSql(accountId, statusId));
    return rows.length > 0;
  });

export const isStatusPinned = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ present: number }>(db, isStatusPinnedSql(accountId, statusId));
    return rows.length > 0;
  });

export const countPinnedStatuses = async (
  db: D1Database,
  accountId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ count: number | bigint }>(
      db,
      countPinnedStatusesSql(accountId),
    );
    return Number(rows[0]?.count ?? 0);
  });

export const listPinnedStatuses = async (
  db: D1Database,
  accountId: string,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(db, listPinnedStatusesSql(accountId));
    return hydrateStatusRows(db, results);
  });
