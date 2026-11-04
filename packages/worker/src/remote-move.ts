import type { InstanceIdentity, LocalAccount, OutboxJob, RemoteActor } from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { listAccountAliases } from "./account-alias-store";
import { type AccountRef, findAccountRef, localRef, refAccountId, remoteRef } from "./account-ref";
import { findAccountById, findAccountByUsername } from "./account-store";
import { parseLocalActorUsername } from "./activitypub";
import { findBlock } from "./block-mute-store";
import type { RepositoryError } from "./d1";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { findFollowKind, followAccount, type FollowOptions } from "./follow-store";
import { notifyAccount, notifyFromRemote } from "./notify";
import { parseInstanceIdentity } from "./runtime-config";
import { followRemoteActor, unfollowRemoteActor } from "./outbound-follow";
import { findOutboundFollow, listOutboundFollowsByActor } from "./outbound-follow-store";
import { actorAliases, remoteActorFromDocument } from "./remote-actor-fetch";
import {
  findRemoteActorByUri,
  setRemoteActorMovedTo,
  upsertRemoteActor,
} from "./remote-actor-store";

/**
 * Follows moved per pass. The first page is moved while the `Move` is handled;
 * a full page queues a `MoveFollows` job for the next, so one `Move` never
 * costs more than a page of work however many local accounts follow the actor.
 */
export const MOVE_PAGE_SIZE = 50;

const UriSchema = z.union([z.string().min(1), z.object({ id: z.string().min(1) }).passthrough()]);

const MoveSchema = z.object({ object: UriSchema, target: UriSchema }).passthrough();

const parseMove = schemaResult(MoveSchema);

const uriOf = (value: z.infer<typeof UriSchema>): string =>
  typeof value === "string" ? value : value.id;

/**
 * Follow `to` for `follower` with `options`, as Mastodon's `FollowService`
 * does for a moved follow. `false` when the follow is refused: a block either
 * way, a domain block or federation limits, or the follower being `to`. A
 * follow of `to` that exists is kept as it is.
 */
const followMoveTarget = async (
  env: Env,
  identity: InstanceIdentity,
  follower: LocalAccount,
  to: AccountRef,
  options: FollowOptions,
): Promise<Result<boolean, RepositoryError>> => {
  if (to.kind === "RemoteActor") {
    const existing = await findOutboundFollow(env.DB, follower.id, to.actorUri);
    if (existing.isErr()) {
      return err(existing.error);
    }
    if (existing.value) {
      return ok(true);
    }
    const followed = await followRemoteActor(env, identity, follower, to.actor, options);
    if (followed.isErr()) {
      return followed.error.kind === "RepositoryError" ? err(followed.error) : ok(false);
    }
    return ok(true);
  }
  const target = to.account;
  if (target.id === follower.id) {
    return ok(false);
  }
  const [blocking, blocked] = await Promise.all([
    findBlock(env.DB, follower.id, target.id),
    findBlock(env.DB, target.id, follower.id),
  ]);
  if (blocking.isErr()) {
    return err(blocking.error);
  }
  if (blocked.isErr()) {
    return err(blocked.error);
  }
  if (blocking.value || blocked.value) {
    return ok(false);
  }
  const existing = await findFollowKind(env.DB, follower.id, target.id);
  if (existing.isErr()) {
    return err(existing.error);
  }
  if (existing.value !== undefined) {
    return ok(true);
  }
  const followed = await followAccount(env.DB, follower.id, target.id, target.locked, options);
  if (followed.isErr()) {
    return err(followed.error);
  }
  if (followed.value.kind === "LocalFollower" && followed.value.follow.kind !== "None") {
    await notifyAccount(env, {
      accountId: target.id,
      fromAccountId: follower.id,
      kind: followed.value.follow.kind === "Pending" ? "follow_request" : "follow",
    });
  }
  return ok(true);
};

/**
 * Move one page of local follows of `from` to `to`, as Mastodon's
 * `UnfollowFollowWorker` does for each follower: follow `to` with the same
 * options (a follow of `to` that exists is kept), then unfollow `from`, and
 * tell the follower with a `move` notification. A follower whose follow of
 * `to` is refused (see {@link followMoveTarget}) keeps the follow of `from`.
 * Redoing a page changes nothing: moved follows are gone from `from`.
 * Resolves to the cursor of the next page, or `undefined` when this was the last.
 */
export const moveFollowPage = async (
  env: Env,
  identity: InstanceIdentity,
  from: RemoteActor,
  to: AccountRef,
  afterId: string,
  pageSize: number = MOVE_PAGE_SIZE,
): Promise<Result<string | undefined, RepositoryError>> => {
  const page = await listOutboundFollowsByActor(env.DB, from.actorUri, afterId, pageSize);
  if (page.isErr()) {
    return err(page.error);
  }
  for (const follow of page.value) {
    const follower = await findAccountById(env.DB, follow.accountId);
    if (follower.isErr()) {
      return err(follower.error);
    }
    if (!follower.value) {
      continue;
    }
    const followed = await followMoveTarget(env, identity, follower.value, to, {
      reblogs: follow.reblogs,
      notify: follow.notify,
      languages: follow.languages,
    });
    if (followed.isErr()) {
      return err(followed.error);
    }
    if (!followed.value) {
      continue;
    }
    const unfollowed = await unfollowRemoteActor(env, identity, follower.value, from);
    if (unfollowed.isErr()) {
      return err(unfollowed.error);
    }
    await notifyFromRemote(env, {
      accountId: follower.value.id,
      actorUri: from.actorUri,
      kind: "move",
      targetAccountId: refAccountId(to),
    });
  }
  const last = page.value.at(-1);
  return ok(page.value.length >= pageSize ? last?.id : undefined);
};

const queueNextPage = async (
  env: Env,
  from: RemoteActor,
  to: AccountRef,
  afterId: string,
): Promise<void> => {
  const job: OutboxJob = {
    kind: "MoveFollows",
    fromActorUri: from.actorUri,
    toActorUri: to.actorUri,
    afterId,
  };
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job);
  } catch {
    console.error(JSON.stringify({ kind: "MoveFollowsNotQueued", fromActorUri: from.actorUri }));
  }
};

/**
 * The account a `Move` names as its target, with the accounts it says it
 * moved from. A local target answers from its own aliases; a remote one is
 * fetched fresh (a cached document could predate the alias) and cached.
 * `undefined` when the target cannot be found or read.
 */
const moveTarget = async (
  env: Env,
  identity: InstanceIdentity,
  targetUri: string,
  options: FederatedFetchOptions,
): Promise<
  Result<Readonly<{ ref: AccountRef; aliases: ReadonlyArray<string> }> | undefined, RepositoryError>
> => {
  const username = parseLocalActorUsername(identity, targetUri);
  if (username !== undefined) {
    const account = await findAccountByUsername(env.DB, username);
    if (account.isErr()) {
      return err(account.error);
    }
    if (!account.value) {
      return ok(undefined);
    }
    const aliases = await listAccountAliases(env.DB, account.value.id);
    if (aliases.isErr()) {
      return err(aliases.error);
    }
    return ok({
      ref: localRef(identity, account.value),
      aliases: aliases.value.map((alias) => alias.actorUri),
    });
  }
  const document = await fetchActivityJson(identity, targetUri, options);
  if (document.isErr()) {
    return ok(undefined);
  }
  const target = remoteActorFromDocument(document.value, targetUri);
  if (target.isErr()) {
    return ok(undefined);
  }
  const cached = await upsertRemoteActor(env.DB, target.value);
  if (cached.isErr()) {
    return err(cached.error);
  }
  return ok({ ref: remoteRef(cached.value), aliases: actorAliases(document.value) });
};

/**
 * Handle an inbox `Move` from a signature-verified remote actor (Mastodon's
 * `ActivityPub::Activity::Move`). It counts only when the signer moves itself
 * (`object` is the signer) and the target lists the signer in `alsoKnownAs`
 * (see {@link moveTarget}); anything else is ignored. A counted move is
 * recorded on the signer, and its local followers are moved to the target.
 *
 * Followers of local accounts need nothing here: the new server sends its own
 * `Follow`, as for Mastodon.
 */
export const applyRemoteMove = async (
  env: Env,
  identity: InstanceIdentity,
  signer: RemoteActor,
  raw: unknown,
  options: FederatedFetchOptions = {},
): Promise<Result<void, RepositoryError>> => {
  const move = parseMove(raw);
  if (move.isErr() || uriOf(move.value.object) !== signer.actorUri) {
    return ok(undefined);
  }
  const targetUri = uriOf(move.value.target);
  if (targetUri === signer.actorUri) {
    return ok(undefined);
  }
  const target = await moveTarget(env, identity, targetUri, options);
  if (target.isErr()) {
    return err(target.error);
  }
  if (!target.value || !target.value.aliases.includes(signer.actorUri)) {
    return ok(undefined);
  }
  const recorded = await setRemoteActorMovedTo(env.DB, signer.actorUri, target.value.ref.actorUri);
  if (recorded.isErr()) {
    return err(recorded.error);
  }
  const next = await moveFollowPage(env, identity, signer, target.value.ref, "");
  if (next.isErr()) {
    return err(next.error);
  }
  if (next.value !== undefined) {
    await queueNextPage(env, signer, target.value.ref, next.value);
  }
  return ok(undefined);
};

/** Move the next page of follows queued by {@link applyRemoteMove}. */
export const processMoveFollowsJob = async (
  env: Env,
  job: Extract<OutboxJob, { kind: "MoveFollows" }>,
): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return "retry";
  }
  const from = await findRemoteActorByUri(env.DB, job.fromActorUri);
  const to = await findAccountRef(env.DB, identity.value, job.toActorUri);
  if (from.isErr() || to.isErr()) {
    return "retry";
  }
  // Only a move that was verified and recorded carries follows over.
  if (!from.value || !to.value || from.value.movedTo !== to.value.actorUri) {
    return "ok";
  }
  const next = await moveFollowPage(env, identity.value, from.value, to.value, job.afterId);
  if (next.isErr()) {
    return "retry";
  }
  if (next.value !== undefined) {
    await queueNextPage(env, from.value, to.value, next.value);
  }
  return "ok";
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([MoveSchema]);
