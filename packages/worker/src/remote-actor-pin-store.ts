import type { RemoteStatus } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { type RepositoryError, runD1 } from "./d1";
import {
  deleteRemoteActorPins as deleteRemoteActorPinsSql,
  insertRemoteActorPin as insertRemoteActorPinSql,
  listRemoteActorPinnedStatuses as listRemoteActorPinnedStatusesSql,
} from "./generated/prisma/sql";
import { parseRemoteStatusRow, remoteStatusFromRow } from "./remote-status-store";
import { queryTyped, runTypedBatch } from "./typed-sql";

/** Make `statusIds`, in this order, the notes `actorUri` pinned. */
export const replaceRemoteActorPins = async (
  db: D1Database,
  actorUri: string,
  statusIds: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> =>
  (
    await runTypedBatch(db, [
      deleteRemoteActorPinsSql(actorUri),
      ...statusIds.map((statusId, position) =>
        insertRemoteActorPinSql(actorUri, statusId, position),
      ),
    ])
  ).map(() => undefined);

/** The public and unlisted notes `actorUri` pinned, in its order. */
export const listRemoteActorPinnedStatuses = async (
  db: D1Database,
  actorUri: string,
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listRemoteActorPinnedStatusesSql(actorUri));
    return rows.flatMap((raw) => {
      const row = parseRemoteStatusRow(raw);
      const status = row.isOk() ? remoteStatusFromRow(row.value) : undefined;
      return status?.isOk() ? [status.value] : [];
    });
  });
