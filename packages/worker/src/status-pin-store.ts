import { z } from "zod";
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
import { hydrateStatusRows, StatusRowSchema } from "./status-store";

const StatusIdRow = z.object({ status_id: z.string() });
const PresentRow = z.object({ present: z.number() });
const CountRow = z.object({ count: z.union([z.number(), z.bigint()]) });

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
    const rows = await queryTyped(db, unpinStatusSql(accountId, statusId), StatusIdRow);
    return rows.length > 0;
  });

export const isStatusPinned = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, isStatusPinnedSql(accountId, statusId), PresentRow);
    return rows.length > 0;
  });

export const countPinnedStatuses = async (
  db: D1Database,
  accountId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, countPinnedStatusesSql(accountId), CountRow);
    return Number(rows[0]?.count ?? 0);
  });

export const listPinnedStatuses = async (
  db: D1Database,
  accountId: string,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(db, listPinnedStatusesSql(accountId), StatusRowSchema);
    return hydrateStatusRows(db, results);
  });
