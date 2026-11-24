import type { InstanceIdentity, OutboxJob } from "@tstodon/domain";
import { suspendedDomains } from "./admin-domain-block-store";
import { refreshRemoteActor } from "./remote-actor-fetch";
import { claimRemoteActorRefresh, listStaleRemoteActorUris } from "./remote-actor-store";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";
import { instanceActorFetchSigner } from "./instance-actor";
import type { TypedSqlLike } from "./typed-sql";

/**
 * How much one cron run may refresh: at most `actors` actors, none started
 * once `ms` have passed. An actor costs at most seventeen subrequests (its
 * document, up to three WebFinger lookups in its round trip and, when the
 * refetch fails, one lookup of its stored handle, each lookup up to four
 * requests, one plus three redirects), each document and each lookup cut off
 * after 5 s.
 */
export type RefreshBudget = Readonly<{ actors: number; ms: number }>;

/**
 * 200 actors keep a run at most 3400 fetches and about 610 D1 queries, inside
 * the Workers Paid limits of 10,000 subrequests and 1000 D1 queries per
 * invocation, and refresh up to 4800 actors a day. With four at a time and
 * none started after 45 s, a run whose servers all time out ends within about
 * 70 s.
 */
const RUN_BUDGET: RefreshBudget = { actors: 200, ms: 45_000 };

/** Actors refreshed at a time. */
const CONCURRENCY = 4;

/** Due actors listed per query. */
const PAGE = 25;

type RefreshJob = Extract<OutboxJob, { kind: "RefreshRemoteActor" }>;

const fetchOptions = async (env: Env, identity: InstanceIdentity) => ({
  allowHosts: await federationAllowHosts(env),
  blockedHosts: await suspendedDomains(env.DB),
  fetchSigner: instanceActorFetchSigner(env.DB, identity),
});

/**
 * The statement that makes an actor due the hourly refresh again as soon as
 * a day has passed since its last fetch, as Mastodon's
 * `refresh_remote_account!` clears `last_webfingered_at`: it forgets the
 * last refresh attempt and WebFinger confirmation. A refresh confirms the
 * handle again.
 */
export const remoteActorRefreshDueSql = (actorUri: string): TypedSqlLike => ({
  sql: `UPDATE remote_actors SET refresh_attempted_at = NULL, last_webfingered_at = NULL
        WHERE actor_uri = $1`,
  values: [actorUri],
});

/**
 * Queue a re-fetch of an actor an admin unsuspended, as Mastodon's
 * `UnsuspendAccountService#refresh_remote_account!` resolves the account
 * straight away. A send the queue refuses is logged; the unsuspension made
 * the actor due the hourly refresh ({@link remoteActorRefreshDueSql}), whose
 * suspended fetches kept its `fetched_at` from before the suspension.
 */
export const queueRemoteActorRefresh = async (env: Env, actorUri: string): Promise<void> => {
  const job: RefreshJob = { kind: "RefreshRemoteActor", actorUri };
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job);
  } catch {
    console.error(JSON.stringify({ kind: "JobNotQueued", jobKind: job.kind }));
  }
};

/**
 * Re-fetch one actor whatever its last refresh, as a refresh the cron makes
 * ({@link refreshRemoteActor}). An actor on a host a suspension covers, or
 * outside the allow list, is not fetched, as Mastodon's
 * `ProcessAccountService` stops at `domain_not_allowed?`.
 */
export const processRefreshRemoteActorJob = async (
  env: Env,
  job: RefreshJob,
): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return "retry";
  }
  const refreshed = await refreshRemoteActor(
    env.DB,
    identity.value,
    job.actorUri,
    await fetchOptions(env, identity.value),
  );
  return refreshed.isOk() ? "ok" : "retry";
};

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
 * whose own WebFinger now links another actor moves back to the URI host.
 */
export const refreshStaleRemoteActors = async (
  env: Env,
  budget: RefreshBudget = RUN_BUDGET,
): Promise<void> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return;
  }
  const options = await fetchOptions(env, identity.value);
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
