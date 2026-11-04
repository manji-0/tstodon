import type {
  InstanceIdentity,
  LocalAccount,
  MovePhase,
  OutboxJob,
  RemoteActor,
} from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { listAccountAliases } from "./account-alias-store";
import { type AccountRef, findAccountRef, localRef, refAccountId, remoteRef } from "./account-ref";
import { findAccountMove, listAcceptedFollowsPage } from "./account-move-store";
import { findAccountById, findAccountByUsername } from "./account-store";
import { parseLocalActorUsername } from "./activitypub";
import type { RepositoryError } from "./d1";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { followAccountRef } from "./follow-ref";
import { type FollowOptions, unfollowAccount } from "./follow-store";
import { type ListMember, listListsContainingMember, replaceListMember } from "./list-store";
import { moveBlockPage, moveMutePage, moveNotePage } from "./move-carry";
import { notifyAccount, notifyFromRemote } from "./notify";
import { parseInstanceIdentity } from "./runtime-config";
import { unfollowRemoteActor } from "./outbound-follow";
import { listOutboundFollowsByActor } from "./outbound-follow-store";
import { actorAliases, remoteActorFromDocument } from "./remote-actor-fetch";
import { setRemoteActorMovedTo, upsertRemoteActor } from "./remote-actor-store";

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

/** A local account's follow of the account that moved: who follows, with which options. */
type MovingFollow = Readonly<{ id: string; followerAccountId: string; options: FollowOptions }>;

/** One page of the local follows of `from`, after `afterId` in id order. */
const movingFollows = async (
  db: D1Database,
  from: AccountRef,
  afterId: string,
  pageSize: number,
): Promise<Result<ReadonlyArray<MovingFollow>, RepositoryError>> => {
  if (from.kind === "LocalAccount") {
    return listAcceptedFollowsPage(db, from.account.id, afterId, pageSize);
  }
  const page = await listOutboundFollowsByActor(db, from.actorUri, afterId, pageSize);
  return page.map((follows) =>
    follows.map((follow) => ({
      id: follow.id,
      followerAccountId: follow.accountId,
      options: { reblogs: follow.reblogs, notify: follow.notify, languages: follow.languages },
    })),
  );
};

const unfollowMoved = async (
  env: Env,
  identity: InstanceIdentity,
  follower: LocalAccount,
  from: AccountRef,
): Promise<Result<void, RepositoryError>> =>
  from.kind === "LocalAccount"
    ? unfollowAccount(env.DB, follower.id, from.account.id)
    : unfollowRemoteActor(env, identity, follower, from.actor);

const notifyMoved = (
  env: Env,
  follower: LocalAccount,
  from: AccountRef,
  to: AccountRef,
): Promise<Result<void, RepositoryError>> =>
  from.kind === "LocalAccount"
    ? notifyAccount(env, {
        accountId: follower.id,
        fromAccountId: from.account.id,
        kind: "move",
        targetAccountId: refAccountId(to),
      })
    : notifyFromRemote(env, {
        accountId: follower.id,
        actorUri: from.actorUri,
        kind: "move",
        targetAccountId: refAccountId(to),
      });

const listMemberOf = (ref: AccountRef): ListMember =>
  ref.kind === "LocalAccount"
    ? { kind: "LocalAccount", accountId: ref.account.id }
    : { kind: "RemoteActor", actorUri: ref.actorUri };

/**
 * Move one page of local follows of `from` to `to`, as Mastodon's
 * `UnfollowFollowWorker` does for each follower: follow `to` with the same
 * options (a follow of `to` that exists is kept), put `to` on the lists that
 * held `from` (a remote `from` leaves its lists with the follow), then
 * unfollow `from`, and tell the follower with a `move` notification. A
 * follower whose follow of `to` is refused (see {@link followAccountRef})
 * keeps the follow of `from` and its lists.
 * Redoing a page changes nothing: moved follows are gone from `from`.
 * Resolves to the cursor of the next page, or `undefined` when this was the last.
 */
export const moveFollowPage = async (
  env: Env,
  identity: InstanceIdentity,
  from: AccountRef,
  to: AccountRef,
  afterId: string,
  pageSize: number = MOVE_PAGE_SIZE,
): Promise<Result<string | undefined, RepositoryError>> => {
  const page = await movingFollows(env.DB, from, afterId, pageSize);
  if (page.isErr()) {
    return err(page.error);
  }
  for (const follow of page.value) {
    const follower = await findAccountById(env.DB, follow.followerAccountId);
    if (follower.isErr()) {
      return err(follower.error);
    }
    if (!follower.value) {
      continue;
    }
    const followed = await followAccountRef(env, identity, follower.value, to, follow.options, {
      kind: "Keep",
    });
    if (followed.isErr()) {
      return err(followed.error);
    }
    if (!followed.value) {
      continue;
    }
    const lists = await listListsContainingMember(env.DB, follower.value.id, listMemberOf(from));
    if (lists.isErr()) {
      return err(lists.error);
    }
    const carried = await replaceListMember(
      env.DB,
      follower.value.id,
      lists.value,
      listMemberOf(from),
      listMemberOf(to),
    );
    if (carried.isErr()) {
      return err(carried.error);
    }
    const unfollowed = await unfollowMoved(env, identity, follower.value, from);
    if (unfollowed.isErr()) {
      return err(unfollowed.error);
    }
    await notifyMoved(env, follower.value, from, to);
  }
  const last = page.value.at(-1);
  return ok(page.value.length >= pageSize ? last?.id : undefined);
};

/** What is carried over to the account moved to, in this order. */
const MOVE_PHASES: ReadonlyArray<MovePhase> = ["follows", "notes", "blocks", "mutes"];

/** Where carrying a move over stands: the phase and the last account done in it. */
export type MoveCursor = Readonly<{ phase: MovePhase; afterId: string }>;

const movePhasePage = (
  env: Env,
  identity: InstanceIdentity,
  from: AccountRef,
  to: AccountRef,
  cursor: MoveCursor,
  pageSize: number,
): Promise<Result<string | undefined, RepositoryError>> => {
  switch (cursor.phase) {
    case "follows":
      return moveFollowPage(env, identity, from, to, cursor.afterId, pageSize);
    case "notes":
      return moveNotePage(env, from, to, { afterId: cursor.afterId, pageSize });
    case "blocks":
      return moveBlockPage(env, from, to, { afterId: cursor.afterId, pageSize });
    case "mutes":
      return moveMutePage(env, from, to, { afterId: cursor.afterId, pageSize });
  }
};

/**
 * Carry a page of the move from `cursor` on, as Mastodon's `MoveWorker`: the
 * local follows (with their list memberships), then the notes, blocks and
 * mutes of local accounts. A phase that ends within the page goes straight
 * on to the next, so one call costs at most a page per phase. Resolves to the
 * cursor of the next page, or `undefined` when everything is carried over.
 */
export const moveCarryPage = async (
  env: Env,
  identity: InstanceIdentity,
  from: AccountRef,
  to: AccountRef,
  cursor: MoveCursor,
  pageSize: number = MOVE_PAGE_SIZE,
): Promise<Result<MoveCursor | undefined, RepositoryError>> => {
  for (const phase of MOVE_PHASES.slice(MOVE_PHASES.indexOf(cursor.phase))) {
    const here = phase === cursor.phase ? cursor : { phase, afterId: "" };
    const next = await movePhasePage(env, identity, from, to, here, pageSize);
    if (next.isErr()) {
      return err(next.error);
    }
    if (next.value !== undefined) {
      return ok({ phase, afterId: next.value });
    }
  }
  return ok(undefined);
};

/**
 * Carry the first page of each thing a move carries over now, and queue a
 * `MoveFollows` job for the rest. The caller has verified and recorded the move.
 */
export const startMovingFollows = async (
  env: Env,
  identity: InstanceIdentity,
  from: AccountRef,
  to: AccountRef,
): Promise<Result<void, RepositoryError>> => {
  const next = await moveCarryPage(env, identity, from, to, { phase: "follows", afterId: "" });
  if (next.isErr()) {
    return err(next.error);
  }
  if (next.value !== undefined) {
    const job: OutboxJob = {
      kind: "MoveFollows",
      fromActorUri: from.actorUri,
      toActorUri: to.actorUri,
      phase: next.value.phase,
      afterId: next.value.afterId,
    };
    try {
      await env.OUTBOX_PROCESS_QUEUE.send(job);
    } catch {
      console.error(JSON.stringify({ kind: "MoveFollowsNotQueued", fromActorUri: from.actorUri }));
    }
  }
  return ok(undefined);
};

/**
 * The account a `Move` names as its target, with the accounts it says it
 * moved from. A local target answers from its own aliases; a remote one is
 * fetched fresh (a cached document could predate the alias) and cached.
 * `undefined` when the target cannot be found or read.
 */
export const findMoveTarget = async (
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
 * (see {@link findMoveTarget}); anything else is ignored. A counted move is
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
  const target = await findMoveTarget(env, identity, targetUri, options);
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
  return startMovingFollows(env, identity, remoteRef(signer), target.value.ref);
};

/** Whether `from` has a verified, recorded move to `to`. */
const movedTo = async (
  db: D1Database,
  from: AccountRef,
  to: AccountRef,
): Promise<Result<boolean, RepositoryError>> => {
  if (from.kind === "RemoteActor") {
    return ok(from.actor.movedTo === to.actorUri);
  }
  const move = await findAccountMove(db, from.account.id);
  return move.map((found) => found?.targetUri === to.actorUri);
};

/** Carry the next page of a move queued by {@link startMovingFollows}. */
export const processMoveFollowsJob = async (
  env: Env,
  job: Extract<OutboxJob, { kind: "MoveFollows" }>,
): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return "retry";
  }
  const from = await findAccountRef(env.DB, identity.value, job.fromActorUri);
  const to = await findAccountRef(env.DB, identity.value, job.toActorUri);
  if (from.isErr() || to.isErr()) {
    return "retry";
  }
  if (!from.value || !to.value) {
    return "ok";
  }
  // Only a move that was verified and recorded carries follows over.
  const recorded = await movedTo(env.DB, from.value, to.value);
  if (recorded.isErr()) {
    return "retry";
  }
  if (!recorded.value) {
    return "ok";
  }
  const next = await moveCarryPage(env, identity.value, from.value, to.value, {
    phase: job.phase,
    afterId: job.afterId,
  });
  if (next.isErr()) {
    return "retry";
  }
  if (next.value !== undefined) {
    const queued: OutboxJob = { ...job, ...next.value };
    try {
      await env.OUTBOX_PROCESS_QUEUE.send(queued);
    } catch {
      console.error(
        JSON.stringify({ kind: "MoveFollowsNotQueued", fromActorUri: job.fromActorUri }),
      );
    }
  }
  return "ok";
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([MoveSchema]);
