import { type RemoteStatus } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import {
  findRemoteStatusReplyTargetByObjectUri as findRemoteStatusReplyTargetByObjectUriSql,
  findRemoteStatusReplyTargets as findRemoteStatusReplyTargetsSql,
} from "./generated/prisma/sql";
import { queryTyped } from "./typed-sql";
import { parseRemoteStatusRow, remoteStatusFromRow } from "./remote-status-store";
import { REMOTE_STATUS_SELECT } from "./remote-status-timeline-store";

/** Cached remote notes answering any of these URIs, oldest first. */
export const listRemoteRepliesToUris = async (
  db: D1Database,
  uris: ReadonlyArray<string>,
  limit: number,
): Promise<Result<RemoteStatus[], RepositoryError>> => {
  if (uris.length === 0 || limit <= 0) {
    return ok([]);
  }
  return runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${REMOTE_STATUS_SELECT} FROM remote_statuses s
         WHERE s.in_reply_to_uri IN (SELECT value FROM json_each(?))
         ORDER BY s.id ASC LIMIT ?`,
      )
      .bind(jsonStringArray([...new Set(uris)]), limit)
      .all();
    const statuses: RemoteStatus[] = [];
    for (const raw of results ?? []) {
      const row = parseRemoteStatusRow(raw);
      if (row.isErr()) {
        continue;
      }
      const parsed = remoteStatusFromRow(row.value);
      if (parsed.isOk()) {
        statuses.push(parsed.value);
      }
    }
    return statuses;
  });
};

/** What a conversation needs to walk up a remote reply chain. */
export type RemoteReplyTarget = Readonly<{
  id: string;
  objectUri: string;
  direct: boolean;
  inReplyToUri: string | undefined;
}>;

type ReplyTargetRow = {
  id: string;
  object_uri: string;
  visibility: string;
  in_reply_to_uri: string | null;
};

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
  const targets = new Map<string, RemoteReplyTarget>();
  if (statusIds.length === 0) {
    return ok(targets);
  }
  const rows = await runD1(async () =>
    queryTyped<ReplyTargetRow>(
      db,
      findRemoteStatusReplyTargetsSql(jsonStringArray([...new Set(statusIds)])),
    ),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  for (const row of rows.value) {
    targets.set(row.id, replyTargetFromRow(row));
  }
  return ok(targets);
};

export const findRemoteStatusReplyTargetByObjectUri = async (
  db: D1Database,
  objectUri: string,
): Promise<Result<RemoteReplyTarget | undefined, RepositoryError>> => {
  const rows = await runD1(async () =>
    queryTyped<ReplyTargetRow>(db, findRemoteStatusReplyTargetByObjectUriSql(objectUri)),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  const row = rows.value[0];
  return ok(row ? replyTargetFromRow(row) : undefined);
};
