import { RemoteActorModeration } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { nowIso } from "./clock";
import { jsonStringArray, runD1, type RepositoryError } from "./d1";
import {
  deleteRemoteActorModeration as deleteRemoteActorModerationSql,
  findRemoteActorModeration as findRemoteActorModerationSql,
  listRemoteActorModerations as listRemoteActorModerationsSql,
  upsertRemoteActorModeration as upsertRemoteActorModerationSql,
} from "./generated/prisma/sql";
import { queryTyped, runTyped } from "./typed-sql";

type ModerationColumns = Readonly<{ moderation: string | null; sensitized: number }>;

/** The columns hold only values this store writes; anything else reads as the default. */
const moderationOf = (row: ModerationColumns): RemoteActorModeration => ({
  standing:
    row.moderation === "Silenced"
      ? { kind: "Silenced" }
      : row.moderation === "Suspended"
        ? { kind: "Suspended" }
        : { kind: "InGoodStanding" },
  sensitized: row.sensitized !== 0,
});

export const getRemoteActorModeration = async (
  db: D1Database,
  actorUri: string,
): Promise<Result<RemoteActorModeration, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<ModerationColumns>(db, findRemoteActorModerationSql(actorUri));
    return rows[0] ? moderationOf(rows[0]) : RemoteActorModeration.inGoodStanding;
  });

/** Actors in the default state are absent from the map. */
export const listRemoteActorModerations = async (
  db: D1Database,
  actorUris: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, RemoteActorModeration>, RepositoryError>> =>
  runD1(async () => {
    const unique = [...new Set(actorUris)];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await queryTyped<ModerationColumns & Readonly<{ actor_uri: string }>>(
      db,
      listRemoteActorModerationsSql(jsonStringArray(unique)),
    );
    return new Map(rows.map((row) => [row.actor_uri, moderationOf(row)]));
  });

/** Store an actor's moderation; the default state keeps no row. */
export const setRemoteActorModeration = async (
  db: D1Database,
  actorUri: string,
  moderation: RemoteActorModeration,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    if (RemoteActorModeration.isDefault(moderation)) {
      await runTyped(db, deleteRemoteActorModerationSql(actorUri));
      return;
    }
    await runTyped(
      db,
      upsertRemoteActorModerationSql(
        actorUri,
        moderation.standing.kind === "InGoodStanding" ? null : moderation.standing.kind,
        moderation.sensitized ? 1 : 0,
        nowIso(),
      ),
    );
  });
