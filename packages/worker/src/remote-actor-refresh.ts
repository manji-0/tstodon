import { suspendedDomains } from "./admin-domain-block-store";
import { refreshRemoteActor } from "./remote-actor-fetch";
import { claimRemoteActorRefresh, listStaleRemoteActorUris } from "./remote-actor-store";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";

/**
 * How much one cron run may refresh: at most `actors` actors, none started
 * once `ms` have passed. An actor costs at most thirteen subrequests (its
 * document and up to three WebFinger lookups of up to four requests each, one
 * plus three redirects; or, when the document fails, one lookup of its stored
 * handle), each document and each lookup cut off after 5 s.
 */
export type RefreshBudget = Readonly<{ actors: number; ms: number }>;

/**
 * 200 actors keep a run at most 2600 fetches and about 610 D1 queries, inside
 * the Workers Paid limits of 10,000 subrequests and 1000 D1 queries per
 * invocation, and refresh up to 4800 actors a day. With four at a time and
 * none started after 45 s, a run whose servers all time out ends within about
 * 65 s.
 */
const RUN_BUDGET: RefreshBudget = { actors: 200, ms: 45_000 };

/** Actors refreshed at a time. */
const CONCURRENCY = 4;

/** Due actors listed per query. */
const PAGE = 25;

/**
 * Hourly cron path: re-fetch the actors due a refresh (a day after both
 * their last WebFinger confirmation, or their last fetch when WebFinger
 * never confirmed them, and their last refresh attempt), the longest waiting
 * first, and run the round trip for each again, until none is due or the
 * run's budget is spent. Each is claimed as tried just before it is fetched,
 * so an actor whose server never answers waits another day instead of
 * holding the head of the queue, and an actor a handle lookup refreshed
 * meanwhile is not fetched twice. Rows cached before the round trip carry
 * the URI host and take the confirmed handle this way; a confirmed handle
 * whose WebFinger stopped vouching moves back to the URI host.
 */
export const refreshStaleRemoteActors = async (
  env: Env,
  budget: RefreshBudget = RUN_BUDGET,
): Promise<void> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return;
  }
  const options = {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: await suspendedDomains(env.DB),
  };
  const deadline = Date.now() + budget.ms;
  let started = 0;
  const withinBudget = () => started < budget.actors && Date.now() < deadline;
  while (withinBudget()) {
    const listed = await listStaleRemoteActorUris(env.DB, Math.min(PAGE, budget.actors - started));
    if (listed.isErr() || listed.value.length === 0) {
      return;
    }
    const queue = [...listed.value];
    const before = started;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let uri = queue.shift(); uri !== undefined && withinBudget(); uri = queue.shift()) {
          // Counted before the claim's await, so the workers never start more than the budget.
          started += 1;
          const claimed = await claimRemoteActorRefresh(env.DB, uri);
          if (claimed.isOk() && claimed.value) {
            await refreshRemoteActor(env.DB, identity.value, uri, options);
          } else {
            started -= 1;
          }
        }
      }),
    );
    if (started === before) {
      return;
    }
  }
};
