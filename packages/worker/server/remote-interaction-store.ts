import { z } from "zod";
import { runD1, type RepositoryError } from "./d1";
import { nowIso } from "./clock";
import { newEntityId } from "./ids";
import type { Result } from "neverthrow";
import { queryTyped, runTyped } from "./typed-sql";
import {
  deleteRemoteAnnounce as deleteRemoteAnnounceSql,
  deleteRemoteFavourite as deleteRemoteFavouriteSql,
  listPollInteractorInboxes as listPollInteractorInboxesSql,
  listStatusReachInboxes as listStatusReachInboxesSql,
  upsertRemoteAnnounce as upsertRemoteAnnounceSql,
  upsertRemoteFavourite as upsertRemoteFavouriteSql,
} from "./generated/prisma/sql";

const IdRow = z.object({ id: z.string().nullable() });
const IdCreatedAtRow = z.object({ id: z.string().nullable(), created_at: z.string() });
const InboxUriRow = z.object({ inbox_uri: z.string() });

/** Record a remote Like; `true` only when it is new (a redelivery answers `false`). */
export const upsertRemoteFavourite = async (
  db: D1Database,
  remoteActorUri: string,
  statusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      upsertRemoteFavouriteSql(newEntityId(), remoteActorUri, statusId, nowIso()),
      IdRow,
    );
    return rows.length > 0;
  });

export const deleteRemoteFavourite = async (
  db: D1Database,
  remoteActorUri: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteRemoteFavouriteSql(remoteActorUri, statusId));
  });

/** Record a remote Announce; `true` only when it is new (a redelivery answers `false`). */
export const upsertRemoteAnnounce = async (
  db: D1Database,
  remoteActorUri: string,
  statusId: string,
  activityId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const now = nowIso();
    const rows = await queryTyped(
      db,
      upsertRemoteAnnounceSql(newEntityId(), remoteActorUri, statusId, activityId, now),
      IdCreatedAtRow,
    );
    // The conflict path keeps the original row, so its `created_at` predates `now`.
    return rows[0]?.created_at === now;
  });

export const deleteRemoteAnnounce = async (
  db: D1Database,
  remoteActorUri: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteRemoteAnnounceSql(remoteActorUri, statusId));
  });

/**
 * The inboxes a local status's poll `Update` reaches beyond its addressing:
 * its remote voters and, for a public or unlisted status, its remote
 * boosters, without suspended or blocked actors.
 */
export const listPollInteractorInboxes = async (
  db: D1Database,
  statusId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listPollInteractorInboxesSql(statusId), InboxUriRow);
    return rows.map((row) => row.inbox_uri);
  });

/**
 * The inboxes of the remote actors that mention (a local status), boost,
 * favourite or reply to a status, without suspended actors: the
 * `ListStatusInteractorInboxes` lookup. `uri` is the status's ActivityPub id.
 */
export const listStatusInteractorInboxes = async (
  db: D1Database,
  status: Readonly<
    | { kind: "Local"; statusId: string; uri: string }
    | { kind: "Remote"; statusId: string; uri: string }
  >,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      listStatusReachInboxesSql(
        status.kind === "Local" ? status.statusId : "",
        status.kind === "Remote" ? status.statusId : "",
        status.uri,
      ),
      InboxUriRow,
    );
    return rows.map((row) => row.inbox_uri);
  });
