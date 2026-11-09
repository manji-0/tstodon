import {
  IpBlock,
  type IpBlockExpiry,
  IpBlockSeverity,
  type IpBlockValue,
  type IpRangeValue,
  IpRange,
  type ListIpBlocks,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { parseRows, runD1, type RepositoryError } from "./d1";
import {
  deleteIpBlock as deleteIpBlockSql,
  findIpBlockById as findIpBlockByIdSql,
  findIpBlockByIp as findIpBlockByIpSql,
  insertIpBlock as insertIpBlockSql,
  listIpBlocks as listIpBlocksSql,
  updateIpBlock as updateIpBlockSql,
} from "./generated/prisma/sql";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { newEntityId } from "./ids";
import { queryTyped, runTyped } from "./typed-sql";

/**
 * The `ip_blocks` table (migration 0122). A row whose range or severity does
 * not parse is left out, so a hand-edited row cannot break enforcement.
 */

const IpBlockRowSchema = z.object({
  id: z.string(),
  ip: z.string(),
  severity: z.string(),
  comment: z.string(),
  created_at: z.string(),
  expires_at: z.string().nullable(),
});

type IpBlockRow = z.infer<typeof IpBlockRowSchema>;

const blockFromRow = (row: IpBlockRow): IpBlockValue[] => {
  const range = IpRange.parse(row.ip);
  const severity = IpBlockSeverity.fromName(row.severity);
  const expiry: IpBlockExpiry =
    row.expires_at === null ? { kind: "Permanent" } : { kind: "Expires", at: row.expires_at };
  if (range.isErr() || severity === undefined) {
    return [];
  }
  const parsed = IpBlock.parse({
    id: row.id,
    range: range.value,
    severity,
    comment: row.comment,
    createdAt: row.created_at,
    expiry,
  });
  return parsed.isOk() ? [parsed.value] : [];
};

const expiresAtText = (expiry: IpBlockExpiry): string =>
  expiry.kind === "Expires" ? expiry.at : "";

/** Every IP block, expired ones included (the caller decides what is in force). */
export const listIpBlocks =
  (db: D1Database): ListIpBlocks =>
  async () =>
    runD1(async () =>
      (await queryTyped(db, listIpBlocksSql(), IpBlockRowSchema)).flatMap(blockFromRow),
    );

/** A page of IP blocks for the admin list, newest first, by Mastodon's id cursors. */
export const listIpBlockPage = async (
  db: D1Database,
  cursor: IdCursor,
  limit: number,
): Promise<Result<IpBlockValue[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT id, ip, severity, comment, created_at, expires_at
         FROM ip_blocks WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(...binds, limit)
      .all();
    return parseRows(IpBlockRowSchema, results).flatMap(blockFromRow);
  });

export const findIpBlockById = async (
  db: D1Database,
  id: string,
): Promise<Result<IpBlockValue | undefined, RepositoryError>> =>
  runD1(async () =>
    (await queryTyped(db, findIpBlockByIdSql(id), IpBlockRowSchema)).flatMap(blockFromRow).at(0),
  );

/** The block on exactly this range, if any (one range is stored once). */
export const findIpBlockByRange = async (
  db: D1Database,
  range: IpRangeValue,
): Promise<Result<IpBlockValue | undefined, RepositoryError>> =>
  runD1(async () =>
    (await queryTyped(db, findIpBlockByIpSql(range), IpBlockRowSchema)).flatMap(blockFromRow).at(0),
  );

export type IpBlockInput = Readonly<{
  range: IpRangeValue;
  severity: IpBlockValue["severity"];
  comment: string;
  expiry: IpBlockExpiry;
}>;

export const insertIpBlock = async (
  db: D1Database,
  input: IpBlockInput,
): Promise<Result<IpBlockValue | undefined, RepositoryError>> => {
  const id = newEntityId();
  const inserted = await runD1(() =>
    runTyped(
      db,
      insertIpBlockSql(
        id,
        input.range,
        IpBlockSeverity.toName(input.severity),
        input.comment,
        nowIso(),
        expiresAtText(input.expiry),
      ),
    ),
  );
  return inserted.isErr() ? err(inserted.error) : findIpBlockById(db, id);
};

export const updateIpBlock = async (
  db: D1Database,
  id: string,
  input: IpBlockInput,
): Promise<Result<IpBlockValue | undefined, RepositoryError>> => {
  const updated = await runD1(() =>
    runTyped(
      db,
      updateIpBlockSql(
        id,
        input.range,
        IpBlockSeverity.toName(input.severity),
        input.comment,
        expiresAtText(input.expiry),
        nowIso(),
      ),
    ),
  );
  return updated.isErr() ? err(updated.error) : findIpBlockById(db, id);
};

/** Resolves to whether a block was deleted. */
export const deleteIpBlock = async (
  db: D1Database,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  (await runD1(() => runTyped(db, deleteIpBlockSql(id)))).andThen((result) =>
    ok(result.meta.changes > 0),
  );
