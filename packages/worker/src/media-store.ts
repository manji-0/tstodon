import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, runD1, sqlInJsonEach, type RepositoryError } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import { parseRow } from "./d1";
import {
  deleteMedia as deleteMediaSql,
  findMediaById as findMediaByIdSql,
  insertMedia as insertMediaSql,
  updateMediaMetadata as updateMediaMetadataSql,
} from "./generated/prisma/sql";

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
    accountId: string;
    objectKey: string;
    contentType: string;
  },
): Promise<Result<MediaRow, RepositoryError>> =>
  runD1(async () => {
    const id = newEntityId();
    const createdAt = nowIso();
    // Prisma 7 exposes TypedSQL writes through $queryRawTyped (no $executeRawTyped yet).
    await runTyped(
      db,
      insertMediaSql(id, input.accountId, input.objectKey, input.contentType, createdAt),
    );
    return {
      id,
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
    const rows = await queryTyped(db, findMediaByIdSql(id));
    const row = parseRow(MediaRowSchema, rows[0]);
    return row.isOk() ? row.value : undefined;
  });

/** Dynamic IN arity stays on D1 prepare until fixed-arity TypedSQL variants land. */
export const findMediaByIds = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<Map<string, MediaRow>, RepositoryError>> => {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  const media = new Map<string, MediaRow>();
  if (unique.length === 0) {
    return ok(media);
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
  for (const raw of queried.value.results ?? []) {
    const row = parseRow(MediaRowSchema, raw);
    if (row.isOk()) {
      media.set(row.value.id, row.value);
    }
  }
  return ok(media);
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
    const rows = await queryTyped<{ id: string }>(
      db,
      updateMediaMetadataSql(
        input.id,
        input.accountId,
        input.description,
        input.focusX,
        input.focusY,
      ),
    );
    return rows.length > 0;
  });

/** Delete a media row, returning its object key so the caller can drop the object. */
export const deleteMedia = async (
  db: D1Database,
  id: string,
  accountId: string,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ object_key: string }>(db, deleteMediaSql(id, accountId));
    return rows[0]?.object_key;
  });
