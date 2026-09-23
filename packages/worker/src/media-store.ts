import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, runD1, sqlInJsonEach, type RepositoryError } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import { nowIso } from "./clock";
import {
  findMediaById as findMediaByIdSql,
  insertMedia as insertMediaSql,
} from "./generated/prisma/sql";

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
    };
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
    return {
      id: row.id,
      account_id: row.account_id,
      status_id: row.status_id,
      object_key: row.object_key,
      content_type: row.content_type,
      created_at: row.created_at,
    };
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
        `SELECT id, account_id, status_id, object_key, content_type, created_at
         FROM media_attachments WHERE id ${sqlInJsonEach()}`,
      )
      .bind(jsonStringArray(unique))
      .all<MediaRow>(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  for (const row of queried.value.results ?? []) {
    media.set(row.id, row);
  }
  return ok(media);
};
