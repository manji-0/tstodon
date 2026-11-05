import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, runD1, sqlInJsonEach, type RepositoryError } from "./d1";
import { queryTyped, runTyped, runTypedBatch } from "./typed-sql";
import { legacyAttachmentObjectKey } from "./media-keys";
import type { LegacyMediaPolicy } from "./runtime-config";
import { nowIso } from "./clock";
import { parseRows } from "./d1";
import {
  clearLegacyMediaKey as clearLegacyMediaKeySql,
  deleteMedia as deleteMediaSql,
  findMediaById as findMediaByIdSql,
  insertMedia as insertMediaSql,
  listLegacyMedia as listLegacyMediaSql,
  rekeyLegacyMedia as rekeyLegacyMediaSql,
  rewriteEditedMediaKey as rewriteEditedMediaKeySql,
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
    description: string | null;
    focus: Readonly<{ x: number; y: number }> | null;
  },
): Promise<Result<MediaRow, RepositoryError>> =>
  runD1(async () => {
    const createdAt = nowIso();
    const focusX = input.focus?.x ?? null;
    const focusY = input.focus?.y ?? null;
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
  legacy_object_key: z.string().min(1).nullable(),
});

/**
 * An attachment the rekey job still has work on: `AtLegacyKey` while the row
 * points at its id-derived key, `LegacyKept` once it points at a random key
 * and the object under the legacy key is still stored.
 */
export type LegacyMedia =
  | Readonly<{ kind: "AtLegacyKey"; id: string; accountId: string; legacyObjectKey: string }>
  | Readonly<{ kind: "LegacyKept"; id: string; objectKey: string; legacyObjectKey: string }>;

const legacyMediaOf = (row: z.infer<typeof LegacyMediaRowSchema>): ReadonlyArray<LegacyMedia> => {
  if (row.object_key === legacyAttachmentObjectKey(row.account_id, row.id)) {
    return [
      {
        kind: "AtLegacyKey",
        id: row.id,
        accountId: row.account_id,
        legacyObjectKey: row.object_key,
      },
    ];
  }
  return row.legacy_object_key === null
    ? []
    : [
        {
          kind: "LegacyKept",
          id: row.id,
          objectKey: row.object_key,
          legacyObjectKey: row.legacy_object_key,
        },
      ];
};

/**
 * The next rows after `afterId`, in id order, that the job has work on under
 * `policy`: every row at its legacy key, and, when legacy objects are to be
 * deleted, every row that still keeps one. Rows are matched by their key, so
 * one written by the previous Worker during a deploy is found too.
 */
export const listLegacyMedia = async (
  db: D1Database,
  policy: LegacyMediaPolicy,
  afterId: string,
  limit: number,
): Promise<Result<ReadonlyArray<LegacyMedia>, RepositoryError>> => {
  const includeKept = policy.kind === "DeleteLegacy" ? 1 : 0;
  return runD1(async () =>
    (
      await queryTyped(db, listLegacyMediaSql(afterId, includeKept, limit), LegacyMediaRowSchema)
    ).flatMap(legacyMediaOf),
  );
};

/**
 * Point a row still at its legacy key to `objectKey`, and its status's edit
 * history with it, in one batch. `legacyStored` says whether an object is
 * left under the legacy key to remember. False when the row moved on or is gone.
 */
export const rekeyLegacyMedia = async (
  db: D1Database,
  input: Readonly<{
    id: string;
    legacyObjectKey: string;
    objectKey: string;
    legacyStored: boolean;
  }>,
): Promise<Result<boolean, RepositoryError>> => {
  const batch = await runTypedBatch(db, [
    rekeyLegacyMediaSql(
      input.id,
      input.legacyObjectKey,
      input.objectKey,
      input.legacyStored ? 1 : 0,
    ),
    rewriteEditedMediaKeySql(input.id, input.legacyObjectKey, input.objectKey),
  ]);
  return batch.map((results) => parseRows(IdRow, results[0]?.results).length > 0);
};

/**
 * Replace the URL of a row's legacy key with its current one in its status's
 * edit history, which stores each revision's rendered document. A no-op once done.
 */
export const rewriteEditedMediaKey = async (
  db: D1Database,
  media: Readonly<{ id: string; legacyObjectKey: string; objectKey: string }>,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, rewriteEditedMediaKeySql(media.id, media.legacyObjectKey, media.objectKey));
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
