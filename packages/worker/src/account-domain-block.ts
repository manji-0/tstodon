import type { Hostname, InstanceIdentity, LocalAccount, OutboxJob } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountById } from "./account-store";
import type { RepositoryError } from "./d1";
import { blockDomain } from "./domain-block-store";
import { newEntityId } from "./ids";
import { measureJobPage } from "./metrics";
import { unfollowRemoteActor } from "./outbound-follow";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { removeRemoteFollower } from "./remote-follower";
import { parseInstanceIdentity } from "./runtime-config";
import {
  finishAccountSeverance,
  listDomainFollowPeers,
  recordAccountSeverancePage,
} from "./severed-relationship-store";
import { notifySeverance } from "./severance";

/** Actors one pass severs; a larger domain continues in queued pages. */
export const SEVER_PAGE_SIZE = 20;

type SeverJob = Extract<OutboxJob, { kind: "SeverBlockedDomainFollows" }>;

type SeveredPage = Readonly<{ severed: number; next: SeverJob | undefined }>;

/**
 * Sever the next page of the account's follows with the blocked domain, as
 * Mastodon's `AfterBlockDomainFromAccountService`: record the accepted ones
 * under the `user_domain_block` event, unfollow each followed actor (an
 * `Undo(Follow)`) and remove each follower or request (a `Reject(Follow)`).
 * The last page closes the event and notifies the account.
 */
const severPage = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  job: SeverJob,
): Promise<Result<SeveredPage, RepositoryError>> => {
  const peers = await listDomainFollowPeers(
    env.DB,
    account.id,
    job.domain,
    job.afterActorUri,
    SEVER_PAGE_SIZE,
  );
  if (peers.isErr()) {
    return err(peers.error);
  }
  const actorUris = peers.value.map((peer) => peer.actorUri);
  const recorded = await recordAccountSeverancePage(env.DB, {
    eventId: job.eventId,
    type: "user_domain_block",
    targetName: job.domain,
    accountId: account.id,
    actorUris,
  });
  if (recorded.isErr()) {
    return err(recorded.error);
  }
  const actors = await findRemoteActorsByUris(env.DB, actorUris);
  if (actors.isErr()) {
    return err(actors.error);
  }
  for (const peer of peers.value) {
    const actor = actors.value.get(peer.actorUri);
    if (!actor) {
      continue;
    }
    const logFailure = (step: string, result: Result<unknown, RepositoryError>) => {
      if (result.isErr()) {
        console.error(
          JSON.stringify({
            kind: "DomainBlockFollowNotSevered",
            step,
            accountId: account.id,
            actorUri: peer.actorUri,
            message: result.error.message,
          }),
        );
      }
    };
    if (peer.following) {
      logFailure("Unfollow", await unfollowRemoteActor(env, identity, account, actor));
    }
    if (peer.follower) {
      logFailure("RemoveFollower", await removeRemoteFollower(env, identity, account, actor));
    }
  }
  const last = actorUris.at(-1);
  if (actorUris.length === SEVER_PAGE_SIZE && last !== undefined) {
    return ok({ severed: actorUris.length, next: { ...job, afterActorUri: last } });
  }
  const finished = await finishAccountSeverance(env.DB, job.eventId, account.id);
  if (finished.isErr()) {
    return err(finished.error);
  }
  const notified = finished.value ? await notifySeverance(env, [finished.value]) : ok(undefined);
  return notified.map(() => ({ severed: actorUris.length, next: undefined }));
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
 * page is queued to run again. Unblocking restores nothing, as in Mastodon.
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

/** Run a page queued by {@link blockAccountDomain}. */
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
    const page = await severPage(env, identity.value, account.value, job);
    if (page.isErr()) {
      return stalled("retry");
    }
    const chained = page.value.next !== undefined && (await queueSeverJob(env, page.value.next));
    return { outcome: "ok", size: page.value.severed, chained };
  });
