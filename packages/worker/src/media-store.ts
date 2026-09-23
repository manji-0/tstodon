import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, runD1, sqlInJsonEach, type RepositoryError } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import { nowIso } from "./clock";
import {
  findMediaById as findMediaByIdSql,
  insertMedia as insertMediaSql,
  updateMediaMetadata as updateMediaMetadataSql,
  updateMediaStorage as updateMediaStorageSql,
} from "./generated/prisma/sql";

export type MediaRow = {
  id: string;
  account_id: string;
  status_id: string | null;
  object_key: string;
  content_type: string;
  created_at: string;
  description: string;
  focus_x: number | null;
  focus_y: number | null;
  preview_object_key: string | null;
  meta_json: string;
  blurhash: string | null;
  is_private: number;
};

const mapRow = (row: MediaRow): MediaRow => ({
  id: row.id,
  account_id: row.account_id,
  status_id: row.status_id,
  object_key: row.object_key,
  content_type: row.content_type,
  created_at: row.created_at,
  description: row.description ?? "",
  focus_x: row.focus_x ?? null,
  focus_y: row.focus_y ?? null,
  preview_object_key: row.preview_object_key ?? null,
  meta_json: row.meta_json ?? "{}",
  blurhash: row.blurhash ?? null,
  is_private: row.is_private ?? 1,
});

export const insertMedia = async (
  db: D1Database,
  input: {
    id: string;
    accountId: string;
    objectKey: string;
    contentType: string;
    description?: string;
    focusX?: number | null;
    focusY?: number | null;
    previewObjectKey?: string | null;
    metaJson?: string;
    blurhash?: string | null;
    isPrivate?: boolean;
  },
): Promise<Result<MediaRow, RepositoryError>> =>
  runD1(async () => {
    const createdAt = nowIso();
    const description = input.description ?? "";
    const focusX = input.focusX ?? null;
    const focusY = input.focusY ?? null;
    const previewObjectKey = input.previewObjectKey ?? null;
    const metaJson = input.metaJson ?? "{}";
    const blurhash = input.blurhash ?? null;
    const isPrivate = input.isPrivate === false ? 0 : 1;
    await runTyped(
      db,
      insertMediaSql(
        input.id,
        input.accountId,
        input.objectKey,
        input.contentType,
        createdAt,
        description,
        focusX,
        focusY,
        previewObjectKey,
        metaJson,
        blurhash,
        isPrivate,
      ),
    );
    return mapRow({
      id: input.id,
      account_id: input.accountId,
      status_id: null,
      object_key: input.objectKey,
      content_type: input.contentType,
      created_at: createdAt,
      description,
      focus_x: focusX,
      focus_y: focusY,
      preview_object_key: previewObjectKey,
      meta_json: metaJson,
      blurhash,
      is_private: isPrivate,
    });
  });

export const findMediaById = async (
  db: D1Database,
  id: string,
): Promise<Result<MediaRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<MediaRow>(db, findMediaByIdSql(id));
    const row = rows[0];
    if (!row || row.id == null) {
      return undefined;
    }
    return mapRow(row);
  });

export const updateMediaMetadata = async (
  db: D1Database,
  input: {
    accountId: string;
    mediaId: string;
    description: string;
    focusX: number | null;
    focusY: number | null;
  },
): Promise<Result<MediaRow | undefined, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      updateMediaMetadataSql(
        input.description,
        input.focusX,
        input.focusY,
        input.mediaId,
        input.accountId,
      ),
    );
    const rows = await queryTyped<MediaRow>(db, findMediaByIdSql(input.mediaId));
    const row = rows[0];
    if (!row || row.id == null || row.account_id !== input.accountId) {
      return undefined;
    }
    return mapRow(row);
  });

export const updateMediaStorage = async (
  db: D1Database,
  input: {
    accountId: string;
    mediaId: string;
    objectKey: string;
    previewObjectKey: string | null;
    isPrivate: boolean;
  },
): Promise<Result<MediaRow | undefined, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      updateMediaStorageSql(
        input.objectKey,
        input.previewObjectKey,
        input.isPrivate ? 1 : 0,
        input.mediaId,
        input.accountId,
      ),
    );
    const rows = await queryTyped<MediaRow>(db, findMediaByIdSql(input.mediaId));
    const row = rows[0];
    if (!row || row.id == null || row.account_id !== input.accountId) {
      return undefined;
    }
    return mapRow(row);
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
        `SELECT id, account_id, status_id, object_key, content_type, created_at,
                COALESCE(description, '') AS description, focus_x, focus_y,
                preview_object_key, COALESCE(meta_json, '{}') AS meta_json, blurhash,
                COALESCE(is_private, 1) AS is_private
         FROM media_attachments WHERE id ${sqlInJsonEach()}`,
      )
      .bind(jsonStringArray(unique))
      .all<MediaRow>(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  for (const row of queried.value.results ?? []) {
    media.set(row.id, mapRow(row));
  }
  return ok(media);
};
