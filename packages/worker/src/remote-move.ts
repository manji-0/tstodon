import type { InstanceIdentity, OutboxJob, RemoteActor } from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findAccountById } from "./account-store";
import type { RepositoryError } from "./d1";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { notifyFromRemote } from "./notify";
import { parseInstanceIdentity } from "./runtime-config";
import { followRemoteActor, unfollowRemoteActor } from "./outbound-follow";
import { findOutboundFollow, listOutboundFollowsByActor } from "./outbound-follow-store";
import { RemoteAccountId } from "./remote-account-id";
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
 * Move one page of local follows of `from` to `to`, as Mastodon's
 * `UnfollowFollowWorker` does for each follower: follow `to` with the same
 * options (a follow of `to` that exists is kept), then unfollow `from`, and
 * tell the follower with a `move` notification. A follower who blocks `to`,
 * or whose domain block or federation limits refuse it, keeps the follow of
 * `from`. Redoing a page changes nothing: moved follows are gone from `from`.
 * Resolves to the cursor of the next page, or `undefined` when this was the last.
 */
export const moveFollowPage = async (
  env: Env,
  identity: InstanceIdentity,
  from: RemoteActor,
  to: RemoteActor,
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
    const existing = await findOutboundFollow(env.DB, follower.value.id, to.actorUri);
    if (existing.isErr()) {
      return err(existing.error);
    }
    if (!existing.value) {
      const followed = await followRemoteActor(env, identity, follower.value, to, {
        reblogs: follow.reblogs,
        notify: follow.notify,
        languages: follow.languages,
      });
      if (followed.isErr()) {
        if (followed.error.kind === "RepositoryError") {
          return err(followed.error);
        }
        continue;
      }
    }
    const unfollowed = await unfollowRemoteActor(env, identity, follower.value, from);
    if (unfollowed.isErr()) {
      return err(unfollowed.error);
    }
    await notifyFromRemote(env, {
      accountId: follower.value.id,
      actorUri: from.actorUri,
      kind: "move",
      targetAccountId: RemoteAccountId.encode(to.actorUri),
    });
  }
  const last = page.value.at(-1);
  return ok(page.value.length >= pageSize ? last?.id : undefined);
};

const queueNextPage = async (
  env: Env,
  from: RemoteActor,
  to: RemoteActor,
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
 * Handle an inbox `Move` from a signature-verified remote actor (Mastodon's
 * `ActivityPub::Activity::Move`). It counts only when the signer moves itself
 * (`object` is the signer) and the target, fetched fresh, lists the signer in
 * `alsoKnownAs`; anything else is ignored. A counted move is recorded on the
 * signer, and its local followers are moved to the target.
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
  const document = await fetchActivityJson(identity, targetUri, options);
  if (document.isErr()) {
    return ok(undefined);
  }
  const target = remoteActorFromDocument(document.value, targetUri);
  if (target.isErr() || !actorAliases(document.value).includes(signer.actorUri)) {
    return ok(undefined);
  }
  const cached = await upsertRemoteActor(env.DB, target.value);
  if (cached.isErr()) {
    return err(cached.error);
  }
  const recorded = await setRemoteActorMovedTo(env.DB, signer.actorUri, targetUri);
  if (recorded.isErr()) {
    return err(recorded.error);
  }
  const next = await moveFollowPage(env, identity, signer, cached.value, "");
  if (next.isErr()) {
    return err(next.error);
  }
  if (next.value !== undefined) {
    await queueNextPage(env, signer, cached.value, next.value);
  }
  return ok(undefined);
};

/** Move the next page of follows queued by {@link applyRemoteMove}. */
export const processMoveFollowsJob = async (
  env: Env,
  job: Extract<OutboxJob, { kind: "MoveFollows" }>,
): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  const from = await findRemoteActorByUri(env.DB, job.fromActorUri);
  const to = await findRemoteActorByUri(env.DB, job.toActorUri);
  if (identity.isErr() || from.isErr() || to.isErr()) {
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
