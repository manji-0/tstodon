import { runD1, type RepositoryError } from "./d1";
import { nowIso } from "./clock";
import type { Result } from "neverthrow";
import { queryTyped, runTyped } from "./typed-sql";
import {
  countRemoteAnnounces as countRemoteAnnouncesSql,
  countRemoteFavourites as countRemoteFavouritesSql,
  deleteRemoteAnnounce as deleteRemoteAnnounceSql,
  deleteRemoteFavourite as deleteRemoteFavouriteSql,
  upsertRemoteAnnounce as upsertRemoteAnnounceSql,
  upsertRemoteFavourite as upsertRemoteFavouriteSql,
} from "./generated/prisma/sql";

export const upsertRemoteFavourite = async (
  db: D1Database,
  remoteActorUri: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, upsertRemoteFavouriteSql(remoteActorUri, statusId, nowIso()));
  });

export const deleteRemoteFavourite = async (
  db: D1Database,
  remoteActorUri: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteRemoteFavouriteSql(remoteActorUri, statusId));
  });

export const upsertRemoteAnnounce = async (
  db: D1Database,
  remoteActorUri: string,
  statusId: string,
  activityId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, upsertRemoteAnnounceSql(remoteActorUri, statusId, activityId, nowIso()));
  });

export const deleteRemoteAnnounce = async (
  db: D1Database,
  remoteActorUri: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteRemoteAnnounceSql(remoteActorUri, statusId));
  });

export const countRemoteFavourites = async (
  db: D1Database,
  statusId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ count: number }>(db, countRemoteFavouritesSql(statusId));
    return Number(rows[0]?.count ?? 0);
  });

export const countRemoteAnnounces = async (
  db: D1Database,
  statusId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ count: number }>(db, countRemoteAnnouncesSql(statusId));
    return Number(rows[0]?.count ?? 0);
  });
