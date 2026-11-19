import type { InstanceIdentity, OutboxJob, RemoteActor } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountsByIds } from "./account-store";
import type { RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { measureJobPage } from "./metrics";
import { sendFollowUndo } from "./outbound-follow";
import { getRemoteActorModeration } from "./remote-actor-moderation-store";
import { findRemoteActorByUri } from "./remote-actor-store";
import { sendFollowReject } from "./remote-follower";
import { parseInstanceIdentity } from "./runtime-config";
import { notifySeverance } from "./severance";
import {
  listActorPeers,
  listStalledSuspendedActors,
  type SeveredActorPage,
  severActorPage,
} from "./severed-relationship-store";

/** Local accounts one page of a suspended actor's severance covers. */
export const SUSPENDED_ACTOR_PAGE_SIZE = 10;

type SeverJob = Extract<OutboxJob, { kind: "SeverSuspendedActorFollows" }>;

type SeveredPage = Readonly<{ severed: number; next: SeverJob | undefined }>;

/**
 * Tell each account what it lost, and tell the actor's server: a
 * `Reject(Follow)` for each of its follows of a local account, as Mastodon's
 * `SuspendAccountService#reject_remote_follows!`, so that it stops showing
 * them as followed; and an `Undo(Follow)` for each local account's follow of
 * it, as Mastodon sends when it removes those follows
 * (`DeleteAccountService#undo_follows!`). Best effort, as for any unfollow:
 * the follows are gone, so a retry would find nothing to send.
 */
const announcePage = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  severed: SeveredActorPage,
): Promise<void> => {
  const notified = await notifySeverance(env, severed.events);
  const accounts = await findAccountsByIds(env.DB, [
    ...severed.unfollowed.map((follow) => follow.accountId),
    ...severed.rejected.map((follow) => follow.accountId),
  ]);
  const failure = notified.isErr() ? notified.error : accounts.isErr() ? accounts.error : undefined;
  if (failure) {
    console.error(
      JSON.stringify({
        kind: "SuspendedActorSeveranceNotAnnounced",
        actorUri: actor.actorUri,
        message: failure.message,
      }),
    );
  }
  if (accounts.isErr()) {
    return;
  }
  for (const follow of severed.rejected) {
    const account = accounts.value.get(follow.accountId);
    if (account) {
      await sendFollowReject(
        env,
        identity,
        account,
        actor,
        follow.followActivityId ?? actor.actorUri,
      );
    }
  }
  for (const follow of severed.unfollowed) {
    const account = accounts.value.get(follow.accountId);
    if (account && follow.followActivityId !== null) {
      await sendFollowUndo(env, identity, account, actor, follow.followActivityId);
    }
  }
};

/** Sever the follows of the next page of local accounts tied to the actor. */
const severPage = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  job: SeverJob,
): Promise<Result<SeveredPage, RepositoryError>> => {
  const accountIds = await listActorPeers(
    env.DB,
    actor.actorUri,
    job.afterAccountId,
    SUSPENDED_ACTOR_PAGE_SIZE,
  );
  if (accountIds.isErr()) {
    return err(accountIds.error);
  }
  if (accountIds.value.length === 0) {
    return ok({ severed: 0, next: undefined });
  }
  const severed = await severActorPage(env.DB, {
    eventId: job.eventId,
    type: "account_suspension",
    targetName: `${actor.username}@${actor.domain}`,
    actorUri: actor.actorUri,
    accountIds: accountIds.value,
  });
  if (severed.isErr()) {
    return err(severed.error);
  }
  await announcePage(env, identity, actor, severed.value);
  const last = accountIds.value.at(-1);
  return ok({
    severed: accountIds.value.length,
    next:
      accountIds.value.length === SUSPENDED_ACTOR_PAGE_SIZE && last !== undefined
        ? { ...job, afterAccountId: last }
        : undefined,
  });
};

const queueSeverJob = async (env: Env, job: SeverJob): Promise<boolean> => {
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job);
    return true;
  } catch {
    console.error(JSON.stringify({ kind: "SuspendedActorSeverNotQueued", actorUri: job.actorUri }));
    return false;
  }
};

/**
 * Remove the follows between local accounts and an actor an admin just
 * suspended, record them as an `account_suspension` severance, and tell the
 * actor's server. The first page of local accounts is severed now and the
 * rest in queued pages, so the request stays bounded however many local
 * accounts the actor is tied to. A failed first page is queued to run again.
 */
export const severSuspendedActor = async (env: Env, actor: RemoteActor): Promise<void> => {
  const identity = parseInstanceIdentity(env);
  const job: SeverJob = {
    kind: "SeverSuspendedActorFollows",
    actorUri: actor.actorUri,
    eventId: newEntityId(),
    afterAccountId: "",
  };
  const page = identity.isErr() ? undefined : await severPage(env, identity.value, actor, job);
  const next = page === undefined || page.isErr() ? job : page.value.next;
  if (next !== undefined) {
    await queueSeverJob(env, next);
  }
};

/**
 * Run a page queued by {@link severSuspendedActor}. An actor no longer
 * suspended, or no longer known, severs nothing more.
 */
export const processSeverSuspendedActorFollowsJob = (env: Env, job: SeverJob) =>
  measureJobPage(env, job.kind, async () => {
    const stalled = (outcome: "ok" | "retry") => ({ outcome, size: -1, chained: false });
    const identity = parseInstanceIdentity(env);
    const [actor, moderation] = await Promise.all([
      findRemoteActorByUri(env.DB, job.actorUri),
      getRemoteActorModeration(env.DB, job.actorUri),
    ]);
    if (identity.isErr() || actor.isErr() || moderation.isErr()) {
      return stalled("retry");
    }
    if (!actor.value || moderation.value.standing.kind !== "Suspended") {
      return stalled("ok");
    }
    const page = await severPage(env, identity.value, actor.value, job);
    if (page.isErr()) {
      return stalled("retry");
    }
    if (page.value.next === undefined) {
      return { outcome: "ok", size: page.value.severed, chained: false };
    }
    const chained = await queueSeverJob(env, page.value.next);
    return { outcome: chained ? "ok" : "retry", size: page.value.severed, chained };
  });

/** Actors one hourly sweep resumes; any more wait for the next hour. */
const RESUME_LIMIT = 5;
/** A suspension younger than this may still have its next page in the queue. */
const RESUME_AFTER_MS = 60 * 60 * 1000;

/**
 * Restart the severance of actors suspended over an hour ago that still have
 * follows with local accounts: a next page that could not be queued, or a
 * job that gave up its retries (hourly cron). The leftover accounts are
 * recorded under a new event, as each account has one event either way.
 */
export const processResumeSuspendedActorSeverancesJob = (env: Env) =>
  measureJobPage(env, "ResumeSuspendedActorSeverances", async () => {
    const actorUris = await listStalledSuspendedActors(
      env.DB,
      new Date(Date.now() - RESUME_AFTER_MS).toISOString(),
      RESUME_LIMIT,
    );
    if (actorUris.isErr()) {
      return { outcome: "retry", size: -1, chained: false };
    }
    let queued = 0;
    for (const actorUri of actorUris.value) {
      const job: SeverJob = {
        kind: "SeverSuspendedActorFollows",
        actorUri,
        eventId: newEntityId(),
        afterAccountId: "",
      };
      queued += (await queueSeverJob(env, job)) ? 1 : 0;
    }
    return { outcome: "ok", size: actorUris.value.length, chained: queued > 0 };
  });
