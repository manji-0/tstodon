import type { RemoteStatus } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { type RepositoryError, runD1 } from "./d1";
import {
  addRemoteActorPin as addRemoteActorPinSql,
  deleteRemoteActorPinByObjectUri as deleteRemoteActorPinByObjectUriSql,
  deleteRemoteActorPins as deleteRemoteActorPinsSql,
  insertRemoteActorPin as insertRemoteActorPinSql,
  listRemoteActorPinnedStatuses as listRemoteActorPinnedStatusesSql,
  trimRemoteActorPins as trimRemoteActorPinsSql,
} from "./generated/prisma/sql";
import { RemoteStatusRowSchema, remoteStatusFromRow } from "./remote-status-store";
import { queryTyped, runTyped, runTypedBatch } from "./typed-sql";

/**
 * The pins kept per remote actor. Mastodon allows five; an actor that sends
 * more `Add`s than this keeps its newest.
 */
export const REMOTE_ACTOR_PIN_LIMIT = 20;

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

/** Pin `statusId` first among `actorUri`'s pins; a note already pinned keeps its place. */
export const addRemoteActorPin = async (
  db: D1Database,
  actorUri: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  (
    await runTypedBatch(db, [
      addRemoteActorPinSql(actorUri, statusId),
      trimRemoteActorPinsSql(actorUri, REMOTE_ACTOR_PIN_LIMIT),
    ])
  ).map(() => undefined);

/** Unpin the note at `objectUri` from `actorUri`'s pins, when it is one. */
export const removeRemoteActorPin = async (
  db: D1Database,
  actorUri: string,
  objectUri: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteRemoteActorPinByObjectUriSql(actorUri, objectUri));
  });

/**
 * The public and unlisted notes `actorUri` pinned, in its order; none when the
 * viewer blocks its domain or the instance suspends it.
 */
export const listRemoteActorPinnedStatuses = async (
  db: D1Database,
  actorUri: string,
  viewerId: string | undefined,
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      listRemoteActorPinnedStatusesSql(actorUri, viewerId ?? ""),
      RemoteStatusRowSchema,
    );
    return rows.flatMap((row) => {
      const status = remoteStatusFromRow(row);
      return status.isOk() ? [status.value] : [];
    });
  });
