import type { Hostname, InstanceIdentity, LocalAccount, OutboxJob } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountById } from "./account-store";
import type { RepositoryError } from "./d1";
import { blockDomain, isDomainBlocked } from "./domain-block-store";
import { newEntityId } from "./ids";
import { measureJobPage } from "./metrics";
import { forgetDomainNotificationAcceptances } from "./notification-policy-store";
import { sendFollowUndo } from "./outbound-follow";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { sendFollowReject } from "./remote-follower";
import { parseInstanceIdentity } from "./runtime-config";
import {
  finishAccountSeverance,
  listDomainPeers,
  type SeveredAccountPage,
  severAccountPage,
} from "./severed-relationship-store";
import { notifySeverance } from "./severance";

/** Actors one pass severs; a larger domain continues in queued pages. */
export const SEVER_PAGE_SIZE = 20;

type SeverJob = Extract<OutboxJob, { kind: "SeverBlockedDomainFollows" }>;

type SeveredPage = Readonly<{ severed: number; next: SeverJob | undefined }>;

/**
 * Send the `Undo(Follow)`s and `Reject(Follow)`s for the follows a page
 * removed. Delivery is best effort, as for any unfollow: the follows are gone,
 * so a retry would find nothing to send.
 */
const federateSeverance = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  severed: SeveredAccountPage,
): Promise<void> => {
  const actors = await findRemoteActorsByUris(env.DB, [
    ...severed.unfollowed.map((follow) => follow.actorUri),
    ...severed.rejected.map((follow) => follow.actorUri),
  ]);
  if (actors.isErr()) {
    console.error(
      JSON.stringify({
        kind: "DomainBlockSeveranceNotFederated",
        accountId: account.id,
        message: actors.error.message,
      }),
    );
    return;
  }
  for (const follow of severed.unfollowed) {
    const actor = actors.value.get(follow.actorUri);
    if (actor && follow.followActivityId !== null) {
      await sendFollowUndo(env, identity, account, actor, follow.followActivityId);
    }
  }
  for (const follow of severed.rejected) {
    const actor = actors.value.get(follow.actorUri);
    if (actor) {
      await sendFollowReject(
        env,
        identity,
        account,
        actor,
        follow.followActivityId ?? actor.actorUri,
      );
    }
  }
};

/** Write the account's event for the severance and notify it, unless it already was. */
const closeSeverance = async (
  env: Env,
  account: LocalAccount,
  job: SeverJob,
): Promise<Result<void, RepositoryError>> => {
  const finished = await finishAccountSeverance(env.DB, job.eventId, account.id);
  if (finished.isErr()) {
    return err(finished.error);
  }
  return finished.value ? notifySeverance(env, [finished.value]) : ok(undefined);
};

/**
 * Sever the next page of the account's ties with the blocked domain, as
 * Mastodon's `AfterBlockDomainFromAccountService`: remove the follows and
 * requests between the account and the domain's actors, recording the
 * accepted ones under the `user_domain_block` event, and the notifications
 * they sent it, then send an `Undo(Follow)` or `Reject(Follow)` for each
 * follow. The first page also forgets the senders there whose requests the
 * account accepted. The last page closes the event and notifies the account.
 */
const severPage = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  job: SeverJob,
): Promise<Result<SeveredPage, RepositoryError>> => {
  if (job.afterActorUri === "") {
    const forgotten = await forgetDomainNotificationAcceptances(env.DB, account.id, job.domain);
    if (forgotten.isErr()) {
      return err(forgotten.error);
    }
  }
  const actorUris = await listDomainPeers(
    env.DB,
    account.id,
    job.domain,
    job.afterActorUri,
    SEVER_PAGE_SIZE,
  );
  if (actorUris.isErr()) {
    return err(actorUris.error);
  }
  const severed = await severAccountPage(env.DB, {
    eventId: job.eventId,
    type: "user_domain_block",
    targetName: job.domain,
    accountId: account.id,
    actorUris: actorUris.value,
  });
  if (severed.isErr()) {
    return err(severed.error);
  }
  await federateSeverance(env, identity, account, severed.value);
  const last = actorUris.value.at(-1);
  if (actorUris.value.length === SEVER_PAGE_SIZE && last !== undefined) {
    return ok({ severed: actorUris.value.length, next: { ...job, afterActorUri: last } });
  }
  const closed = await closeSeverance(env, account, job);
  return closed.map(() => ({ severed: actorUris.value.length, next: undefined }));
};

const queueSeverJob = async (env: Env, job: SeverJob): Promise<boolean> => {
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job);
    return true;
  } catch {
    console.error(
      JSON.stringify({
        kind: "DomainBlockSeverNotQueued",
        accountId: job.accountId,
        domain: job.domain,
      }),
    );
    return false;
  }
};

/**
 * Block `domain` for the account and sever its follows with the domain. The
 * block row comes first and holds on its own; the first page is severed now
 * and the rest in queued pages, so the request stays bounded. A failed first
 * page is queued to run again. A domain already blocked is left alone: the
 * request that blocked it owns its severance, so a second block cannot split
 * it across two events. Unblocking restores nothing, as in Mastodon.
 */
export const blockAccountDomain = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  domain: Hostname,
): Promise<Result<void, RepositoryError>> => {
  const blocked = await blockDomain(env.DB, account.id, domain);
  if (blocked.isErr()) {
    return err(blocked.error);
  }
  if (!blocked.value) {
    return ok(undefined);
  }
  const job: SeverJob = {
    kind: "SeverBlockedDomainFollows",
    accountId: account.id,
    domain,
    eventId: newEntityId(),
    afterActorUri: "",
  };
  const page = await severPage(env, identity, account, job);
  const next = page.isErr() ? job : page.value.next;
  if (next !== undefined) {
    await queueSeverJob(env, next);
  }
  return ok(undefined);
};

/**
 * Run a page queued by {@link blockAccountDomain}. A domain unblocked since
 * severs nothing more: the event closes with what earlier pages removed.
 */
export const processSeverBlockedDomainFollowsJob = (env: Env, job: SeverJob) =>
  measureJobPage(env, job.kind, async () => {
    const stalled = (outcome: "ok" | "retry") => ({ outcome, size: -1, chained: false });
    const identity = parseInstanceIdentity(env);
    const account = await findAccountById(env.DB, job.accountId);
    if (identity.isErr() || account.isErr()) {
      return stalled("retry");
    }
    if (!account.value) {
      return stalled("ok");
    }
    const blocked = await isDomainBlocked(env.DB, account.value.id, job.domain);
    if (blocked.isErr()) {
      return stalled("retry");
    }
    if (!blocked.value) {
      const closed = await closeSeverance(env, account.value, job);
      return stalled(closed.isOk() ? "ok" : "retry");
    }
    const page = await severPage(env, identity.value, account.value, job);
    if (page.isErr()) {
      return stalled("retry");
    }
    if (page.value.next === undefined) {
      return { outcome: "ok", size: page.value.severed, chained: false };
    }
    // The page's follows are gone and the job is unchanged, so running it
    // again severs the next page.
    const chained = await queueSeverJob(env, page.value.next);
    return { outcome: chained ? "ok" : "retry", size: page.value.severed, chained };
  });
