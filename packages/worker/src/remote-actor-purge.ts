import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { announceRemovedBoosts, enqueueRemovedStatusesFanOut } from "./home-fan-out";
import {
  listRemoteActorFollowerAccountIds,
  listRemoteActorHomeEntryIds,
  purgeRemoteActor,
} from "./remote-actor-store";

/**
 * Newest statuses and boosts of a purged actor that followers are told are
 * gone: a home timeline page. Older ones drop out of a client on its next
 * fetch of the timeline.
 */
export const PURGE_ANNOUNCED_ENTRY_LIMIT = 20;

/** Followers of a purged actor told about it; the rest hear nothing until they refetch. */
export const PURGE_ANNOUNCED_FOLLOWER_LIMIT = 1000;

/**
 * Forget a remote actor that deleted its account and tell what that changes:
 * the local boosts of its statuses go with them (their boosters' followers
 * hear a `delete`), and its followers' streams hear a `delete` for its newest
 * entries. The audience and the entries are read before the purge, which
 * removes the follows and statuses they come from. Resolves to false when the
 * actor was not cached.
 */
export const purgeRemoteActorAndAnnounce = async (
  env: Env,
  actorUri: string,
): Promise<Result<boolean, RepositoryError>> => {
  const entries = await listRemoteActorHomeEntryIds(env.DB, actorUri, PURGE_ANNOUNCED_ENTRY_LIMIT);
  const followers = await listRemoteActorFollowerAccountIds(
    env.DB,
    actorUri,
    PURGE_ANNOUNCED_FOLLOWER_LIMIT,
  );
  if (entries.isErr()) {
    return err(entries.error);
  }
  if (followers.isErr()) {
    return err(followers.error);
  }
  const purged = await purgeRemoteActor(env.DB, actorUri);
  if (purged.isErr()) {
    return err(purged.error);
  }
  if (!purged.value) {
    return ok(false);
  }
  await announceRemovedBoosts(env, purged.value.boosts);
  await enqueueRemovedStatusesFanOut(env, followers.value, entries.value);
  return ok(true);
};
