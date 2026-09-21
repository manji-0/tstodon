import { runD1, type RepositoryError } from "./d1";
import { nowIso } from "./clock";
import type { Result } from "neverthrow";

export const upsertRemoteFavourite = async (
  db: D1Database,
  remoteActorUri: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT INTO remote_favourites (remote_actor_uri, status_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(remote_actor_uri, status_id) DO NOTHING`,
      )
      .bind(remoteActorUri, statusId, nowIso())
      .run();
  });

export const deleteRemoteFavourite = async (
  db: D1Database,
  remoteActorUri: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `DELETE FROM remote_favourites WHERE remote_actor_uri = ? AND status_id = ?`,
      )
      .bind(remoteActorUri, statusId)
      .run();
  });

export const upsertRemoteAnnounce = async (
  db: D1Database,
  remoteActorUri: string,
  statusId: string,
  activityId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT INTO remote_announces (remote_actor_uri, status_id, activity_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(remote_actor_uri, status_id) DO UPDATE SET
           activity_id = excluded.activity_id`,
      )
      .bind(remoteActorUri, statusId, activityId, nowIso())
      .run();
  });

export const deleteRemoteAnnounce = async (
  db: D1Database,
  remoteActorUri: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `DELETE FROM remote_announces WHERE remote_actor_uri = ? AND status_id = ?`,
      )
      .bind(remoteActorUri, statusId)
      .run();
  });

export const countRemoteFavourites = async (
  db: D1Database,
  statusId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM remote_favourites WHERE status_id = ?`,
      )
      .bind(statusId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  });

export const countRemoteAnnounces = async (
  db: D1Database,
  statusId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM remote_announces WHERE status_id = ?`,
      )
      .bind(statusId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  });
