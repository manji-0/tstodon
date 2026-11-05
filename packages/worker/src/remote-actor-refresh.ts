import { suspendedDomains } from "./admin-domain-block-store";
import { fetchActivityJson } from "./federated-fetch";
import { cacheFetchedActor, remoteActorFromDocument } from "./remote-actor-fetch";
import { listStaleRemoteActorUris, markRemoteActorsRefreshAttempted } from "./remote-actor-store";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";

/** Mastodon's `possibly_stale?` window: an actor fetched longer ago than this is refreshed. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** How many actors one cron run re-fetches. */
const REFRESH_BATCH = 10;

/**
 * Hourly cron path: re-fetch the actors that have waited longest since
 * their last refresh attempt and their last WebFinger confirmation (their
 * last fetch, when WebFinger never confirmed them), once both are over a day
 * ago, and run the round trip for each again. Rows cached before the round
 * trip carry the URI host and take the confirmed handle this way; a
 * confirmed handle whose WebFinger stopped vouching moves back to the URI
 * host. A row whose lookups fail keeps its handle and its confirmation time,
 * so it is tried again after a day. The batch is marked tried before it is
 * fetched, so an actor whose server never answers waits another day instead
 * of holding the head of the queue. A failed or refused fetch leaves the row
 * as it was.
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
  if ((await markRemoteActorsRefreshAttempted(env.DB, uris.value)).isErr()) {
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
