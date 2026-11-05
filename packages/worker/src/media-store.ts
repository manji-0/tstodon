import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, runD1, sqlInJsonEach, type RepositoryError } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import { nowIso } from "./clock";
import { parseRows } from "./d1";
import {
  clearLegacyMediaKey as clearLegacyMediaKeySql,
  deleteMedia as deleteMediaSql,
  findMediaById as findMediaByIdSql,
  insertMedia as insertMediaSql,
  listLegacyMedia as listLegacyMediaSql,
  rekeyLegacyMedia as rekeyLegacyMediaSql,
  updateMediaMetadata as updateMediaMetadataSql,
} from "./generated/prisma/sql";

const IdRow = z.object({ id: z.string() });

export const MediaRowSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  status_id: z.string().nullable(),
  object_key: z.string().min(1),
  content_type: z.string().min(1),
  created_at: z.string().min(1),
  description: z.string().nullable(),
  focus_x: z.number().nullable(),
  focus_y: z.number().nullable(),
});

export type MediaRow = z.infer<typeof MediaRowSchema>;

/** Mastodon's `focus` value: `"x,y"` with each component in [-1, 1]. */
export const parseMediaFocus = (raw: string): Readonly<{ x: number; y: number }> | undefined => {
  const [xRaw, yRaw] = raw.split(",");
  const x = Number.parseFloat((xRaw ?? "").trim());
  const y = Number.parseFloat((yRaw ?? "").trim());
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1 || Math.abs(y) > 1) {
    return undefined;
  }
  return { x, y };
};

export const insertMedia = async (
  db: D1Database,
  input: {
    id: string;
    accountId: string;
    objectKey: string;
    contentType: string;
  },
): Promise<Result<MediaRow, RepositoryError>> =>
  runD1(async () => {
    const createdAt = nowIso();
    // Prisma 7 exposes TypedSQL writes through $queryRawTyped (no $executeRawTyped yet).
    await runTyped(
      db,
      insertMediaSql(input.id, input.accountId, input.objectKey, input.contentType, createdAt),
    );
    return {
      id: input.id,
      account_id: input.accountId,
      status_id: null,
      object_key: input.objectKey,
      content_type: input.contentType,
      created_at: createdAt,
      description: null,
      focus_x: null,
      focus_y: null,
    };
  });

export const findMediaById = async (
  db: D1Database,
  id: string,
): Promise<Result<MediaRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findMediaByIdSql(id), MediaRowSchema);
    return rows[0];
  });

/** Dynamic IN arity stays on D1 prepare until fixed-arity TypedSQL variants land. */
export const findMediaByIds = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<Map<string, MediaRow>, RepositoryError>> => {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (unique.length === 0) {
    return ok(new Map<string, MediaRow>());
  }
  const queried = await runD1(() =>
    db
      .prepare(
        `SELECT id, account_id, status_id, object_key, content_type, created_at, description, focus_x, focus_y
         FROM media_attachments WHERE id ${sqlInJsonEach()}`,
      )
      .bind(jsonStringArray(unique))
      .all(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(new Map(parseRows(MediaRowSchema, queried.value.results).map((row) => [row.id, row])));
};

/** Set alt text and an optional focal point on one of the account's media rows. */
export const updateMediaMetadata = async (
  db: D1Database,
  input: {
    id: string;
    accountId: string;
    description: string | null;
    focusX: number | null;
    focusY: number | null;
  },
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      updateMediaMetadataSql(
        input.id,
        input.accountId,
        input.description,
        input.focusX,
        input.focusY,
      ),
      IdRow,
    );
    return rows.length > 0;
  });

const DeletedMediaRow = z.object({
  object_key: z.string(),
  legacy_object_key: z.string().nullable(),
});

/**
 * Delete a media row, returning the object keys it held (its key, and a
 * legacy key not yet removed) so the caller can drop the objects.
 */
export const deleteMedia = async (
  db: D1Database,
  id: string,
  accountId: string,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, deleteMediaSql(id, accountId), DeletedMediaRow);
    return [
      ...new Set(
        rows.flatMap((row) =>
          row.legacy_object_key === null
            ? [row.object_key]
            : [row.object_key, row.legacy_object_key],
        ),
      ),
    ];
  });

const LegacyMediaRowSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  object_key: z.string().min(1),
  legacy_object_key: z.string().min(1),
});

/**
 * An attachment still tied to a key guessable from its id: `Copy` while the
 * row still points at the legacy key, `DropLegacy` once it points at a fresh
 * key and only the legacy object is left to delete.
 */
export type LegacyMedia =
  | Readonly<{ kind: "Copy"; id: string; accountId: string; legacyObjectKey: string }>
  | Readonly<{ kind: "DropLegacy"; id: string; legacyObjectKey: string }>;

const legacyMediaOf = (row: z.infer<typeof LegacyMediaRowSchema>): LegacyMedia =>
  row.object_key === row.legacy_object_key
    ? {
        kind: "Copy",
        id: row.id,
        accountId: row.account_id,
        legacyObjectKey: row.legacy_object_key,
      }
    : { kind: "DropLegacy", id: row.id, legacyObjectKey: row.legacy_object_key };

export const listLegacyMedia = async (
  db: D1Database,
  limit: number,
): Promise<Result<ReadonlyArray<LegacyMedia>, RepositoryError>> =>
  runD1(async () =>
    (await queryTyped(db, listLegacyMediaSql(limit), LegacyMediaRowSchema)).map(legacyMediaOf),
  );

/** Point a row still at its legacy key to `objectKey`; false when the row moved on or is gone. */
export const rekeyLegacyMedia = async (
  db: D1Database,
  input: Readonly<{ id: string; legacyObjectKey: string; objectKey: string }>,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      rekeyLegacyMediaSql(input.id, input.legacyObjectKey, input.objectKey),
      IdRow,
    );
    return rows.length > 0;
  });

/** Forget a legacy key whose object is gone. */
export const clearLegacyMediaKey = async (
  db: D1Database,
  id: string,
  legacyObjectKey: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await queryTyped(db, clearLegacyMediaKeySql(id, legacyObjectKey), IdRow);
  });
