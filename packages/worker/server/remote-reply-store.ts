import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import {
  findRemoteStatusReplyTargetByObjectUri as findRemoteStatusReplyTargetByObjectUriSql,
  findRemoteStatusReplyTargets as findRemoteStatusReplyTargetsSql,
  findRemoteStatusReplyTargetsByObjectUris as findRemoteStatusReplyTargetsByObjectUrisSql,
} from "./generated/prisma/sql";
import { queryTyped } from "./typed-sql";

/** What a conversation needs to walk up a remote reply chain. */
export type RemoteReplyTarget = Readonly<{
  id: string;
  objectUri: string;
  direct: boolean;
  inReplyToUri: string | undefined;
}>;

const ReplyTargetRowSchema = z.object({
  id: z.string(),
  object_uri: z.string(),
  visibility: z.string(),
  in_reply_to_uri: z.string().nullable(),
});

type ReplyTargetRow = z.infer<typeof ReplyTargetRowSchema>;

const replyTargetFromRow = (row: ReplyTargetRow): RemoteReplyTarget => ({
  id: row.id,
  objectUri: row.object_uri,
  direct: row.visibility === "direct",
  inReplyToUri: row.in_reply_to_uri ?? undefined,
});

export const findRemoteStatusReplyTargets = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, RemoteReplyTarget>, RepositoryError>> => {
  if (statusIds.length === 0) {
    return ok(new Map<string, RemoteReplyTarget>());
  }
  const rows = await runD1(async () =>
    queryTyped(
      db,
      findRemoteStatusReplyTargetsSql(jsonStringArray([...new Set(statusIds)])),
      ReplyTargetRowSchema,
    ),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  return ok(new Map(rows.value.map((row) => [row.id, replyTargetFromRow(row)])));
};

/** Reply targets of cached remote statuses, keyed by object URI. */
export const findRemoteStatusReplyTargetsByObjectUris = async (
  db: D1Database,
  objectUris: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, RemoteReplyTarget>, RepositoryError>> => {
  if (objectUris.length === 0) {
    return ok(new Map<string, RemoteReplyTarget>());
  }
  const rows = await runD1(async () =>
    queryTyped(
      db,
      findRemoteStatusReplyTargetsByObjectUrisSql(jsonStringArray([...new Set(objectUris)])),
      ReplyTargetRowSchema,
    ),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  return ok(new Map(rows.value.map((row) => [row.object_uri, replyTargetFromRow(row)])));
};

export const findRemoteStatusReplyTargetByObjectUri = async (
  db: D1Database,
  objectUri: string,
): Promise<Result<RemoteReplyTarget | undefined, RepositoryError>> => {
  const rows = await runD1(async () =>
    queryTyped(db, findRemoteStatusReplyTargetByObjectUriSql(objectUri), ReplyTargetRowSchema),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  const row = rows.value[0];
  return ok(row ? replyTargetFromRow(row) : undefined);
};
