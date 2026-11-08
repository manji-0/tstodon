import { InstanceIdentity, type LocalAccount } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { addAccountAlias } from "./account-alias-store";
import {
  type AccountMove,
  cancelAccountMove,
  claimAccountMove,
  findAccountMoveRecord,
} from "./account-move-store";
import { localRef, refAcct, resolveAccountHandle, type ResolveHandleError } from "./account-ref";
import { suspendedDomains } from "./admin-domain-block-store";
import { enqueueLocalActivity, type EnqueueLocalActivityError } from "./delivery";
import { newEntityId } from "./ids";
import { sendActorUpdate } from "./local-actor";
import { findMoveTarget, startMovingFollows } from "./remote-move";
import { federationAllowHosts } from "./runtime-config";

export type AddAliasError = ResolveHandleError | Readonly<{ kind: "SelfAlias" }>;

/**
 * Record that `account` moved from the account `handle` names, as Mastodon's
 * `AccountAlias`: the handle must resolve, and it must not be the account itself.
 */
export const addAlias = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  handle: string,
): Promise<Result<void, AddAliasError>> => {
  const old = await resolveAccountHandle(env, identity, handle);
  if (old.isErr()) {
    return err(old.error);
  }
  if (old.value.actorUri === InstanceIdentity.actorUrl(identity, account.username)) {
    return err({ kind: "SelfAlias" });
  }
  return addAccountAlias(env.DB, account.id, {
    acct: refAcct(old.value),
    actorUri: old.value.actorUri,
  });
};

/** Mastodon's `AccountMigration::COOLDOWN_PERIOD`: how long after a move the account may move elsewhere. */
export const MOVE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** When an account that moved at `movedAt` may move somewhere else. */
export const nextMoveAt = (move: AccountMove): Date =>
  new Date(Date.parse(move.movedAt) + MOVE_COOLDOWN_MS);

export type MoveAccountError =
  | ResolveHandleError
  | Readonly<{ kind: "SelfMove" }>
  /** The target's actor document could not be fetched or read. */
  | Readonly<{ kind: "TargetUnavailable" }>
  /** The target does not list this account in `alsoKnownAs`. */
  | Readonly<{ kind: "MissingAlias" }>
  | Readonly<{ kind: "OnCooldown"; until: Date }>
  | EnqueueLocalActivityError;

/**
 * Move `account` to the account `handle` names, as Mastodon's
 * `Settings::MigrationsController#create` and `MoveService`: the target,
 * fetched fresh, must list this account in `alsoKnownAs`, and an account
 * moves somewhere else at most once per {@link MOVE_COOLDOWN_MS}. The move
 * is recorded, a `Move` goes to every remote follower's inbox and an actor
 * `Update` shows `movedTo` to servers that cached the actor, and local
 * followers (with their blocks, mutes, notes and lists) are moved to the
 * target as an inbound `Move` moves them. Repeating a standing move sends the
 * `Move` again and changes nothing else; after a cancelled move the cooldown
 * holds for the same target too.
 */
export const moveAccount = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  handle: string,
  now: Date = new Date(),
): Promise<Result<AccountMove, MoveAccountError>> => {
  const resolved = await resolveAccountHandle(env, identity, handle);
  if (resolved.isErr()) {
    return err(resolved.error);
  }
  const self = localRef(identity, account);
  if (resolved.value.actorUri === self.actorUri) {
    return err({ kind: "SelfMove" });
  }
  const current = await findAccountMoveRecord(env.DB, account.id);
  if (current.isErr()) {
    return err(current.error);
  }
  const standing =
    current.value?.kind === "Moved" && current.value.move.targetUri === resolved.value.actorUri
      ? current.value.move
      : undefined;
  if (current.value && !standing && nextMoveAt(current.value.move) > now) {
    return err({ kind: "OnCooldown", until: nextMoveAt(current.value.move) });
  }
  const target = await findMoveTarget(env, identity, resolved.value.actorUri, {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: await suspendedDomains(env.DB),
  });
  if (target.isErr()) {
    return err(target.error);
  }
  if (!target.value) {
    return err({ kind: "TargetUnavailable" });
  }
  if (!target.value.aliases.includes(self.actorUri)) {
    return err({ kind: "MissingAlias" });
  }
  const move: AccountMove = {
    acct: refAcct(target.value.ref),
    targetUri: target.value.ref.actorUri,
    movedAt: now.toISOString(),
  };
  const claimed = await claimAccountMove(
    env.DB,
    account.id,
    move,
    new Date(now.getTime() - MOVE_COOLDOWN_MS).toISOString(),
  );
  if (claimed.isErr()) {
    return err(claimed.error);
  }
  if (!claimed.value) {
    // Another move won the race since the check above.
    const winner = await findAccountMoveRecord(env.DB, account.id);
    return err({
      kind: "OnCooldown",
      until: winner.isOk() && winner.value ? nextMoveAt(winner.value.move) : now,
    });
  }
  const sent = await enqueueLocalActivity(env, account.id, "Move", {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${self.actorUri}#moves/${newEntityId()}`,
    type: "Move",
    actor: self.actorUri,
    object: self.actorUri,
    target: move.targetUri,
  });
  if (sent.isErr()) {
    return err(sent.error);
  }
  const updated = await sendActorUpdate(env, identity, account);
  if (updated.isErr()) {
    return err(updated.error);
  }
  const moved = await startMovingFollows(env, identity, self, target.value.ref);
  if (moved.isErr()) {
    return err(moved.error);
  }
  return ok(standing ?? move);
};

export type CancelMoveError = Readonly<{ kind: "NotMoved" }> | EnqueueLocalActivityError;

/**
 * Cancel the redirect, as Mastodon's `Settings::MigrationsController#cancel`:
 * the actor stops naming `movedTo` and remote servers are told with an actor
 * `Update`. Followers already moved stay moved, and the cooldown of the move
 * still holds for a new one.
 */
export const cancelMove = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  now: Date = new Date(),
): Promise<Result<void, CancelMoveError>> => {
  const cancelled = await cancelAccountMove(env.DB, account.id, now.toISOString());
  if (cancelled.isErr()) {
    return err(cancelled.error);
  }
  if (!cancelled.value) {
    return err({ kind: "NotMoved" });
  }
  return sendActorUpdate(env, identity, account);
};
