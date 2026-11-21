import { InstanceIdentity, type LocalAccount, type OutboxJob, RemoteActor } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findAccountById, setAccountLocked } from "./account-store";
import { parseRows, type RepositoryError, runD1Batch } from "./d1";
import { enqueueTargetedActivity } from "./delivery";
import { authorizeFollowRequest } from "./follow-store";
import { measureJobPage } from "./metrics";
import {
  authorizeRemoteFollowRequest,
  findPendingRemoteFollowRequest,
  findRemoteActorsByUris,
} from "./remote-actor-store";
import { parseInstanceIdentity } from "./runtime-config";

/** The requests of each kind, local and remote, one page accepts; more continue in queued pages. */
export const AUTHORIZE_PAGE_SIZE = 20;

type AuthorizeJob = Extract<OutboxJob, { kind: "AuthorizeFollowRequests" }>;

/**
 * Accept `actor`'s pending request to follow `account` and send it the
 * `Accept`, as Mastodon's `AuthorizeFollowService`. Answers whether there was
 * a request to accept. Delivery is best effort: the follow stands either way.
 */
export const acceptRemoteFollowRequest = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  actor: RemoteActor,
): Promise<Result<boolean, RepositoryError>> => {
  const followActivityId = await findPendingRemoteFollowRequest(env.DB, account.id, actor.actorUri);
  if (followActivityId.isErr()) {
    return err(followActivityId.error);
  }
  const authorized = await authorizeRemoteFollowRequest(env.DB, account.id, actor.actorUri);
  if (authorized.isErr() || !authorized.value || !followActivityId.value) {
    return authorized;
  }
  const acceptActor = InstanceIdentity.actorUrl(identity, account.username);
  await enqueueTargetedActivity(
    env,
    account,
    "Accept",
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${acceptActor}/activities/accept-${followActivityId.value}`,
      type: "Accept",
      actor: acceptActor,
      object: {
        id: followActivityId.value,
        type: "Follow",
        actor: actor.actorUri,
        object: acceptActor,
      },
    },
    RemoteActor.deliveryInbox(actor),
  );
  return ok(true);
};

const RequesterRow = z.object({ requester: z.string() });

/**
 * The next `limit` pending requests to follow `accountId`, local and remote,
 * that unlocking it accepts: all but those of a silenced or suspended
 * requester (an account, an actor, or an actor's domain), which Mastodon's
 * `authorize_all_follow_requests` leaves pending.
 */
const listAuthorizableRequesters = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<Readonly<{ local: string[]; remote: string[] }>, RepositoryError>> => {
  const listed = await runD1Batch(db, [
    db
      .prepare(
        `SELECT follower_account_id AS requester FROM follows
           WHERE target_account_id = ? AND kind = 'Pending'
             AND follower_account_id NOT IN (
               SELECT account_id FROM account_moderation WHERE moderation IN ('Silenced', 'Suspended'))
           LIMIT ?`,
      )
      .bind(accountId, limit),
    db
      .prepare(
        `SELECT f.remote_actor_uri AS requester
           FROM remote_follows f JOIN remote_actors r ON r.actor_uri = f.remote_actor_uri
           WHERE f.target_account_id = ? AND f.remote_request_kind = 'Queued'
             AND f.remote_actor_uri NOT IN (
               SELECT actor_uri FROM remote_actor_moderation WHERE moderation IN ('Silenced', 'Suspended'))
             AND f.remote_actor_uri NOT IN (
               SELECT actor_uri FROM remote_actor_domain_rules WHERE severity IN ('silence', 'suspend'))
           LIMIT ?`,
      )
      .bind(accountId, limit),
  ]);
  return listed.map(([local, remote]) => ({
    local: parseRows(RequesterRow, local?.results).map((row) => row.requester),
    remote: parseRows(RequesterRow, remote?.results).map((row) => row.requester),
  }));
};

/**
 * Accept the next page of the account's pending requests. Each accepted
 * request leaves the pending set, so a page needs no cursor: the next one
 * lists what is left. Answers whether a full page suggests more remain.
 */
const authorizePage = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
): Promise<Result<Readonly<{ accepted: number; more: boolean }>, RepositoryError>> => {
  const requesters = await listAuthorizableRequesters(env.DB, account.id, AUTHORIZE_PAGE_SIZE);
  if (requesters.isErr()) {
    return err(requesters.error);
  }
  const { local, remote } = requesters.value;
  for (const followerId of local) {
    const authorized = await authorizeFollowRequest(env.DB, account.id, followerId);
    if (authorized.isErr()) {
      return err(authorized.error);
    }
  }
  const actors = await findRemoteActorsByUris(env.DB, remote);
  if (actors.isErr()) {
    return err(actors.error);
  }
  for (const actorUri of remote) {
    // An actor whose cached row does not parse is accepted without an
    // `Accept`, so that it leaves the pending set and the pages end.
    const actor = actors.value.get(actorUri);
    const accepted = actor
      ? await acceptRemoteFollowRequest(env, identity, account, actor)
      : await authorizeRemoteFollowRequest(env.DB, account.id, actorUri);
    if (accepted.isErr()) {
      return err(accepted.error);
    }
  }
  return ok({
    accepted: local.length + remote.length,
    more: local.length === AUTHORIZE_PAGE_SIZE || remote.length === AUTHORIZE_PAGE_SIZE,
  });
};

const queueAuthorizeJob = async (env: Env, accountId: LocalAccount["id"]): Promise<boolean> => {
  const job: AuthorizeJob = { kind: "AuthorizeFollowRequests", accountId };
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job);
    return true;
  } catch {
    console.error(JSON.stringify({ kind: "AuthorizeFollowRequestsNotQueued", accountId }));
    return false;
  }
};

/**
 * Store whether `account` approves followers by hand. Unlocking it accepts
 * its pending requests, as Mastodon's `UpdateAccountService`: the first page
 * now, the rest in queued pages, so the request stays bounded. A failed first
 * page is queued to run again; the lock itself is stored either way. Saving
 * an account as unlocked again accepts what a lost page left pending.
 */
export const changeAccountLocked = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  locked: boolean,
): Promise<Result<void, RepositoryError>> => {
  const stored = await setAccountLocked(env.DB, account.id, locked);
  if (stored.isErr() || locked) {
    return stored;
  }
  // Also when it was unlocked already: requests a page could not queue are
  // still pending, and listing none is one statement.
  const page = await authorizePage(env, identity, { ...account, locked });
  if (page.isErr() || page.value.more) {
    await queueAuthorizeJob(env, account.id);
  }
  return ok(undefined);
};

/**
 * Run a page queued by {@link changeAccountLocked}. An account locked again
 * since accepts nothing more.
 */
export const processAuthorizeFollowRequestsJob = (env: Env, job: AuthorizeJob) =>
  measureJobPage(env, job.kind, async () => {
    const stalled = (outcome: "ok" | "retry") => ({ outcome, size: -1, chained: false });
    const identity = parseInstanceIdentity(env);
    const account = await findAccountById(env.DB, job.accountId);
    if (identity.isErr() || account.isErr()) {
      return stalled("retry");
    }
    if (!account.value || account.value.locked) {
      return stalled("ok");
    }
    const page = await authorizePage(env, identity.value, account.value);
    if (page.isErr()) {
      return stalled("retry");
    }
    if (!page.value.more) {
      return { outcome: "ok", size: page.value.accepted, chained: false };
    }
    const chained = await queueAuthorizeJob(env, account.value.id);
    return { outcome: chained ? "ok" : "retry", size: page.value.accepted, chained };
  });
