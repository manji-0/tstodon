import type { Result } from "neverthrow";
import { z } from "zod";
import { runD1, type RepositoryError } from "./d1";
import {
  sumAccountMediaBytes as sumAccountMediaBytesSql,
  sumStoredMediaBytes as sumStoredMediaBytesSql,
} from "./generated/prisma/sql";
import { queryTyped } from "./typed-sql";

/**
 * The byte sizes of what tstodon stores in the `MEDIA` bucket, as each upload
 * records them: the sums the admin metrics and the export page show.
 */

const StoredBytesRow = z.object({
  attachments: z.number(),
  profiles: z.number(),
  emojis: z.number(),
});

/**
 * What the `MEDIA` bucket holds, from the recorded sizes: attachment
 * originals and previews; avatars and headers; custom emoji images.
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
