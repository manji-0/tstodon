import {
  StoredMediaSizes,
  type HeadStoredMedia,
  type ListUnsizedMedia,
  type RecordStoredMediaSizes,
  type StoredMediaSizeCursor,
  type StoredMediaSizePass,
  type StoredMediaSizeSource,
  type StoredMediaSizeTally,
  type UnsizedObject,
} from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { runD1, type RepositoryError } from "./d1";
import {
  listUnsizedMedia as listUnsizedMediaSql,
  recordAvatarFileSize as recordAvatarFileSizeSql,
  recordCustomEmojiFileSize as recordCustomEmojiFileSizeSql,
  recordHeaderFileSize as recordHeaderFileSizeSql,
  recordMediaFileSizes as recordMediaFileSizesSql,
  sumAccountMediaBytes as sumAccountMediaBytesSql,
  sumStoredMediaBytes as sumStoredMediaBytesSql,
} from "./generated/prisma/sql";
import { queryTyped, runTyped } from "./typed-sql";

/**
 * The byte sizes of what tstodon stores in the `MEDIA` bucket (migration
 * 0125): the `BackfillStoredMediaSizes` job that fills in the sizes of
 * objects stored before they were recorded, and the sums the admin metrics
 * and the export page show.
 */

/** The `source` column of `listUnsizedMedia`: each source's place in the walk. */
const sourceRank = (source: StoredMediaSizeSource): number =>
  StoredMediaSizes.sources.indexOf(source);

const UnsizedRow = z.object({
  source: z.number().int(),
  id: z.string().min(1),
  object_key: z.string().min(1).nullable(),
  preview_object_key: z.string().min(1).nullable(),
});

const objectsOf = (row: z.infer<typeof UnsizedRow>): ReadonlyArray<UnsizedObject> => [
  ...(row.object_key === null ? [] : [{ slot: "file" as const, objectKey: row.object_key }]),
  ...(row.preview_object_key === null
    ? []
    : [{ slot: "preview" as const, objectKey: row.preview_object_key }]),
];

const listUnsizedMedia =
  (db: D1Database): ListUnsizedMedia =>
  (cursor, limit) =>
    runD1(async () =>
      (
        await queryTyped(
          db,
          listUnsizedMediaSql(sourceRank(cursor.source), cursor.afterId, limit),
          UnsizedRow,
        )
      ).flatMap((row) => {
        const source = StoredMediaSizes.sources[row.source];
        const objects = objectsOf(row);
        return source === undefined || objects.length === 0
          ? []
          : [{ source, id: row.id, objects }];
      }),
    );

/** A HEAD of the object: its size without reading its body. */
const headStoredMedia =
  (bucket: R2Bucket): HeadStoredMedia =>
  async (objectKey) =>
    (await bucket.head(objectKey))?.size;

const recordStoredMediaSizes =
  (db: D1Database): RecordStoredMediaSizes =>
  (media, sizes) =>
    runD1(async () => {
      const file = sizes.find((size) => size.slot === "file");
      const preview = sizes.find((size) => size.slot === "preview");
      switch (media.source) {
        case "attachments":
          await runTyped(
            db,
            recordMediaFileSizesSql(
              media.id,
              file?.objectKey ?? null,
              file?.size ?? null,
              preview?.objectKey ?? null,
              preview?.size ?? null,
            ),
          );
          return;
        case "avatars":
        case "headers":
        case "emojis": {
          if (file === undefined) {
            return;
          }
          const record =
            media.source === "avatars"
              ? recordAvatarFileSizeSql
              : media.source === "headers"
                ? recordHeaderFileSizeSql
                : recordCustomEmojiFileSizeSql;
          await runTyped(db, record(media.id, file.objectKey, file.size));
          return;
        }
      }
    });

const logReports = (pass: StoredMediaSizePass): void => {
  for (const report of pass.reports) {
    const line = JSON.stringify({ kind: "MediaSizeNotRead", ...report });
    if (report.outcome.kind === "Missing") {
      // Recorded as 0 bytes: the row names an object the bucket does not hold.
      console.warn(line);
    } else {
      console.error(line);
    }
  }
};

/**
 * One page of `BackfillStoredMediaSizes`: HEAD the next stored objects of
 * unknown size and record their sizes.
 */
export const backfillStoredMediaSizesPage = async (
  env: Env,
  cursor: StoredMediaSizeCursor,
  rows: number = StoredMediaSizes.rows,
): Promise<Result<StoredMediaSizePass, RepositoryError>> => {
  const pass = await StoredMediaSizes.pass(
    {
      list: listUnsizedMedia(env.DB),
      head: headStoredMedia(env.MEDIA),
      record: recordStoredMediaSizes(env.DB),
    },
    cursor,
    rows,
  );
  if (pass.isOk()) {
    logReports(pass.value);
  }
  return pass;
};

/** The log line of the last page: what the whole run did. */
export const logBackfillStoredMediaSizesDone = (tally: StoredMediaSizeTally): void => {
  console.log(JSON.stringify({ kind: "MediaSizeBackfillDone", ...tally }));
};

const StoredBytesRow = z.object({
  attachments: z.number(),
  profiles: z.number(),
  emojis: z.number(),
});

/**
 * What the `MEDIA` bucket holds, from the recorded sizes: attachment
 * originals, kept legacy copies and previews; avatars and headers; custom
 * emoji images. A size not known yet counts 0.
 */
export type StoredMediaBytes = z.infer<typeof StoredBytesRow>;

export const storedMediaBytes = (
  db: D1Database,
): Promise<Result<StoredMediaBytes, RepositoryError>> =>
  runD1(async () => {
    const [row] = await queryTyped(db, sumStoredMediaBytesSql(), StoredBytesRow);
    return row ?? { attachments: 0, profiles: 0, emojis: 0 };
  });

/** The total of {@link StoredMediaBytes}. */
export const totalStoredMediaBytes = (bytes: StoredMediaBytes): number =>
  bytes.attachments + bytes.profiles + bytes.emojis;

const AccountBytesRow = z.object({ attachments: z.number(), profiles: z.number() });

/** What one account's attachments, avatar and header take in the bucket. */
export const accountMediaBytes = (
  db: D1Database,
  accountId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const [row] = await queryTyped(db, sumAccountMediaBytesSql(accountId), AccountBytesRow);
    return row === undefined ? 0 : row.attachments + row.profiles;
  });
