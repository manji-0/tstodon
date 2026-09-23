import { err, ok, type Result } from "neverthrow";
import { chunkArray, runD1, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";

export type MediaRow = {
  id: string;
  account_id: string;
  status_id: string | null;
  object_key: string;
  content_type: string;
  created_at: string;
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
    await db
      .prepare(
        `INSERT INTO media_attachments (id, account_id, object_key, content_type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id, input.accountId, input.objectKey, input.contentType, createdAt)
      .run();
    return {
      id,
      account_id: input.accountId,
      status_id: null,
      object_key: input.objectKey,
      content_type: input.contentType,
      created_at: createdAt,
    };
  });

export const findMediaById = async (
  db: D1Database,
  id: string,
): Promise<Result<MediaRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(
        `SELECT id, account_id, status_id, object_key, content_type, created_at
         FROM media_attachments WHERE id = ?`,
      )
      .bind(id)
      .first<MediaRow>();
    return row ?? undefined;
  });

export const findMediaByIds = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<Map<string, MediaRow>, RepositoryError>> => {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  const media = new Map<string, MediaRow>();
  if (unique.length === 0) {
    return ok(media);
  }
  for (const chunk of chunkArray(unique)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const queried = await runD1(() =>
      db
        .prepare(
          `SELECT id, account_id, status_id, object_key, content_type, created_at
           FROM media_attachments WHERE id IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<MediaRow>(),
    );
    if (queried.isErr()) {
      return err(queried.error);
    }
    for (const row of queried.value.results ?? []) {
      media.set(row.id, row);
    }
  }
  return ok(media);
};
