import { OutboundFollow, type OutboundFollowState } from "@tstodon/domain";
import { warmSchemas } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import { type RepositoryError, runD1 } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import {
  listLocalFollowsOfActor as listLocalFollowsOfActorSql,
  listRemoteFollowerUrisByPrefix as listRemoteFollowerUrisByPrefixSql,
  lockFollowersSynchronization as lockFollowersSynchronizationSql,
  unlockFollowersSynchronization as unlockFollowersSynchronizationSql,
} from "./generated/prisma/sql";

const FollowerUriRow = z.object({ remote_actor_uri: z.string() });

const LocalFollowRow = z.object({
  account_id: z.string().min(1),
  username: z.string().min(1),
  state: z.string(),
  follow_activity_id: z.string().min(1),
});

const LockedRow = z.object({ actor_uri: z.string() });

/** A local account's follow of a remote actor, accepted or requested. */
export type LocalFollowOfActor = Readonly<{
  accountId: string;
  username: string;
  state: OutboundFollowState;
  followActivityId: string;
}>;

/** One `SynchronizeFollowers` job's lock key; `digest` is '' when the header named none. */
export type FollowersSynchronizationKey = Readonly<{
  actorUri: string;
  url: string;
  digest: string;
}>;

/**
 * A lock is held this long at most: a job runs within minutes of being
 * queued, so a lock older than this belongs to a job that was lost.
 */
const LOCK_TTL_MS = 60 * 60 * 1000;

const staleBefore = (now: Date): string => new Date(now.getTime() - LOCK_TTL_MS).toISOString();

/** The URIs of `accountId`'s accepted remote followers under `prefix` (`matches_uri_prefix`). */
export const remoteFollowerUrisUnder = (
  db: D1Database,
  accountId: string,
  prefix: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () =>
    (
      await queryTyped(db, listRemoteFollowerUrisByPrefixSql(accountId, prefix), FollowerUriRow)
    ).map((row) => row.remote_actor_uri),
  );

/** Every local account's follow of `actorUri`; a row whose state does not read is left out. */
export const localFollowsOfActor = (
  db: D1Database,
  actorUri: string,
): Promise<Result<LocalFollowOfActor[], RepositoryError>> =>
  runD1(async () =>
    (await queryTyped(db, listLocalFollowsOfActorSql(actorUri), LocalFollowRow)).flatMap((row) => {
      const state = OutboundFollow.parseState({ kind: row.state });
      return state.isOk()
        ? [
            {
              accountId: row.account_id,
              username: row.username,
              state: state.value,
              followActivityId: row.follow_activity_id,
            },
          ]
        : [];
    }),
  );

/** Take the job's lock: false while the same job is queued and not yet run. */
export const lockFollowersSynchronization = (
  db: D1Database,
  key: FollowersSynchronizationKey,
  now: Date,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      lockFollowersSynchronizationSql(
        key.actorUri,
        key.url,
        key.digest,
        now.toISOString(),
        staleBefore(now),
      ),
      LockedRow,
    );
    return rows.length > 0;
  });

/** Free the job's lock, and any left by a job that was lost. */
export const unlockFollowersSynchronization = (
  db: D1Database,
  key: FollowersSynchronizationKey,
  now: Date,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      unlockFollowersSynchronizationSql(key.actorUri, key.url, key.digest, staleBefore(now)),
    );
  });

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([FollowerUriRow, LocalFollowRow, LockedRow]);
