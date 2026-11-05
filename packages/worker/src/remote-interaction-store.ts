import { z } from "zod";
import { runD1, type RepositoryError } from "./d1";
import { nowIso } from "./clock";
import { newEntityId } from "./ids";
import type { Result } from "neverthrow";
import { queryTyped, runTyped } from "./typed-sql";
import {
  countRemoteAnnounces as countRemoteAnnouncesSql,
  countRemoteFavourites as countRemoteFavouritesSql,
  deleteRemoteAnnounce as deleteRemoteAnnounceSql,
  deleteRemoteFavourite as deleteRemoteFavouriteSql,
  listPollInteractorUris as listPollInteractorUrisSql,
  upsertRemoteAnnounce as upsertRemoteAnnounceSql,
  upsertRemoteFavourite as upsertRemoteFavouriteSql,
} from "./generated/prisma/sql";

const IdRow = z.object({ id: z.string().nullable() });
const IdCreatedAtRow = z.object({ id: z.string().nullable(), created_at: z.string() });
const CountRow = z.object({ count: z.number() });
const ActorUriRow = z.object({ actor_uri: z.string() });

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

export const countRemoteFavourites = async (
  db: D1Database,
  statusId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, countRemoteFavouritesSql(statusId), CountRow);
    return Number(rows[0]?.count ?? 0);
  });

export const countRemoteAnnounces = async (
  db: D1Database,
  statusId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, countRemoteAnnouncesSql(statusId), CountRow);
    return Number(rows[0]?.count ?? 0);
  });

/** The remote actors that voted on a local status's poll or boosted the status. */
export const listPollInteractorUris = async (
  db: D1Database,
  statusId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listPollInteractorUrisSql(statusId), ActorUriRow);
    return rows.map((row) => row.actor_uri);
  });
