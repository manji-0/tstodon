import type { ImageDimensions } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, runD1, sqlInJsonEach, type RepositoryError } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import { nowIso } from "./clock";
import { parseRows } from "./d1";
import {
  deleteMedia as deleteMediaSql,
  deleteUnattachedMedia as deleteUnattachedMediaSql,
  findMediaById as findMediaByIdSql,
  insertMedia as insertMediaSql,
  updateMediaMetadata as updateMediaMetadataSql,
  updateMediaThumbnail as updateMediaThumbnailSql,
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
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  preview_object_key: z.string().min(1).nullable(),
  preview_width: z.number().int().nullable(),
  preview_height: z.number().int().nullable(),
  blurhash: z.string().min(1).nullable(),
  thumbnail_content_type: z.string().min(1).nullable(),
});

export type MediaRow = z.infer<typeof MediaRowSchema>;

/** A preview stored next to an original: its key, type, dimensions and stored byte size. */
export type StoredPreview = Readonly<{
  objectKey: string;
  contentType: string;
  dimensions: ImageDimensions;
  size: number;
}>;

/**
 * What an image upload stores beside the original: its dimensions, the
 * preview (absent when storing it failed), and the blurhash.
 */
export type StoredImage = Readonly<{
  original: ImageDimensions;
  preview: StoredPreview | undefined;
  blurhash: string | null;
}>;

/**
 * A video's custom thumbnail, Mastodon's `thumbnail` attachment: the image
 * as stored at the `small` size, and its blurhash. It takes the place of the
 * row's preview.
 */
export type StoredThumbnail = StoredPreview & Readonly<{ blurhash: string | null }>;

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
    /** The byte size of the original as stored (stripped of its metadata). */
    fileSize: number;
    contentType: string;
    description: string | null;
    focus: Readonly<{ x: number; y: number }> | null;
    image: StoredImage | null;
    thumbnail: StoredThumbnail | null;
  },
): Promise<Result<MediaRow, RepositoryError>> =>
  runD1(async () => {
    const createdAt = nowIso();
    const focusX = input.focus?.x ?? null;
    const focusY = input.focus?.y ?? null;
    const preview = input.thumbnail ?? input.image?.preview;
    const image = {
      width: input.image?.original.width ?? null,
      height: input.image?.original.height ?? null,
      preview_object_key: preview?.objectKey ?? null,
      preview_width: preview?.dimensions.width ?? null,
      preview_height: preview?.dimensions.height ?? null,
      blurhash: (input.thumbnail ?? input.image)?.blurhash ?? null,
      thumbnail_content_type: input.thumbnail?.contentType ?? null,
    };
    // Prisma 7 exposes TypedSQL writes through $queryRawTyped (no $executeRawTyped yet).
    await runTyped(
      db,
      insertMediaSql(
        input.id,
        input.accountId,
        input.objectKey,
        input.contentType,
        createdAt,
        input.description,
        focusX,
        focusY,
        image.width,
        image.height,
        image.preview_object_key,
        image.preview_width,
        image.preview_height,
        image.blurhash,
        input.fileSize,
        preview?.size ?? null,
        image.thumbnail_content_type,
      ),
    );
    return {
      id: input.id,
      account_id: input.accountId,
      status_id: null,
      object_key: input.objectKey,
      content_type: input.contentType,
      created_at: createdAt,
      description: input.description,
      focus_x: focusX,
      focus_y: focusY,
      ...image,
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
        `SELECT id, account_id, status_id, object_key, content_type, created_at, description, focus_x, focus_y,
           width, height, preview_object_key, preview_width, preview_height, blurhash, thumbnail_content_type
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

/**
 * The `media_ids` a status may not attach, in request order, as Mastodon's
 * `validate_media!` finds them: anything but the author's own media that no
 * status holds, or that the edited status (`statusId`) already holds.
 */
export const findUnattachableMediaIds = async (
  db: D1Database,
  accountId: string,
  mediaIds: ReadonlyArray<string>,
  statusId: string | null,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  (await findMediaByIds(db, mediaIds)).map((rows) =>
    mediaIds.filter((id) => {
      const row = rows.get(id);
      return !row || row.account_id !== accountId || ![null, statusId].includes(row.status_id);
    }),
  );

/** Mastodon's `media_attachments.validations.not_found` message. */
export const mediaNotFoundMessage = (ids: ReadonlyArray<string>): string =>
  `Media ${ids.join(", ")} not found or already attached to another post`;

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

/**
 * Set (or, with `null`, clear) the custom thumbnail of one of the account's
 * media rows that no status holds. False when there is no such row.
 */
export const updateMediaThumbnail = async (
  db: D1Database,
  input: Readonly<{ id: string; accountId: string; thumbnail: StoredThumbnail | null }>,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const { thumbnail } = input;
    const rows = await queryTyped(
      db,
      updateMediaThumbnailSql(
        input.id,
        input.accountId,
        thumbnail?.objectKey ?? null,
        thumbnail?.dimensions.width ?? null,
        thumbnail?.dimensions.height ?? null,
        thumbnail?.size ?? null,
        thumbnail?.blurhash ?? null,
        thumbnail?.contentType ?? null,
      ),
      IdRow,
    );
    return rows.length > 0;
  });

const DeletedMediaRow = z.object({
  object_key: z.string(),
  preview_object_key: z.string().nullable(),
});

/**
 * The bucket keys deleted media rows held: each row's key and its preview's.
 */
export const deletedMediaObjectKeys = (
  rows: ReadonlyArray<unknown> | undefined,
): ReadonlyArray<string> => [
  ...new Set(
    parseRows(DeletedMediaRow, rows).flatMap((row) =>
      [row.object_key, row.preview_object_key].filter((key): key is string => key !== null),
    ),
  ),
];

/**
 * Delete a media row, returning the object keys it held (its key and its
 * preview's) so the caller can drop the objects.
 */
export const deleteMedia = async (
  db: D1Database,
  id: string,
  accountId: string,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  runD1(async () =>
    deletedMediaObjectKeys(await queryTyped(db, deleteMediaSql(id, accountId), DeletedMediaRow)),
  );

/**
 * Delete up to `limit` of the oldest media no status, scheduled post or edit
 * history holds, uploaded before `createdBefore`. Resolves to the rows
 * deleted and the object keys they held.
 */
export const deleteUnattachedMedia = async (
  db: D1Database,
  createdBefore: string,
  limit: number,
): Promise<
  Result<Readonly<{ deleted: number; objectKeys: ReadonlyArray<string> }>, RepositoryError>
> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      deleteUnattachedMediaSql(createdBefore, limit),
      DeletedMediaRow,
    );
    return { deleted: rows.length, objectKeys: deletedMediaObjectKeys(rows) };
  });
