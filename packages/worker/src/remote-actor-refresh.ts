import { suspendedDomains } from "./admin-domain-block-store";
import { fetchActivityJson } from "./federated-fetch";
import { cacheFetchedActor, remoteActorFromDocument } from "./remote-actor-fetch";
import { listStaleRemoteActorUris } from "./remote-actor-store";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";

/** Mastodon's `possibly_stale?` window: an actor fetched longer ago than this is refreshed. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** How many actors one cron run re-fetches. */
const REFRESH_BATCH = 10;

/**
 * Cron path: re-fetch a bounded batch of actors cached over a day ago, so a
 * row converges on its current document and the handle WebFinger confirms
 * for it (rows cached before the round trip carry the URI host). The batch
 * is random, so actors on unreachable servers, which keep their old
 * `fetched_at`, never starve the rest. A failed fetch leaves the row as it was.
 */
export const refreshStaleRemoteActors = async (env: Env): Promise<void> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return;
  }
  const before = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const uris = await listStaleRemoteActorUris(env.DB, before, REFRESH_BATCH);
  if (uris.isErr() || uris.value.length === 0) {
    return;
  }
  const options = {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: await suspendedDomains(env.DB),
  };
  for (const actorUri of uris.value) {
    const raw = await fetchActivityJson(identity.value, actorUri, options);
    const actor = raw.isOk() ? remoteActorFromDocument(raw.value, actorUri) : undefined;
    if (actor?.isOk()) {
      await cacheFetchedActor(env.DB, identity.value, actor.value, options);
    }
  }
};
