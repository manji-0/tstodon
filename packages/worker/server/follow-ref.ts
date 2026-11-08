import type { InstanceIdentity, LocalAccount } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { AccountRef } from "./account-ref";
import { findBlock } from "./block-mute-store";
import type { RepositoryError } from "./d1";
import { findFollowKind, followAccount, type FollowOptions } from "./follow-store";
import { notifyNewFollow } from "./notify";
import { followRemoteActor } from "./outbound-follow";
import { findOutboundFollow } from "./outbound-follow-store";

/** What to do when `follower` already follows the target. */
export type ExistingFollow =
  /** Leave the follow and its options as they are (a moved follow). */
  | Readonly<{ kind: "Keep" }>
  /** Set the options given, as following again does (an import). */
  | Readonly<{ kind: "UpdateOptions" }>;

/**
 * Follow `to` for `follower` with `options`, as Mastodon's `FollowService`
 * does for an account that moved and for a followed-accounts import. `false`
 * when the follow is refused: a block either way, a domain block or
 * federation limits, or the follower being `to`.
 */
export const followAccountRef = async (
  env: Env,
  identity: InstanceIdentity,
  follower: LocalAccount,
  to: AccountRef,
  options: FollowOptions,
  onExisting: ExistingFollow,
): Promise<Result<boolean, RepositoryError>> => {
  if (to.kind === "RemoteActor") {
    if (onExisting.kind === "Keep") {
      const existing = await findOutboundFollow(env.DB, follower.id, to.actorUri);
      if (existing.isErr()) {
        return err(existing.error);
      }
      if (existing.value) {
        return ok(true);
      }
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
  if (existing.value !== undefined && onExisting.kind === "Keep") {
    return ok(true);
  }
  const followed = await followAccount(env.DB, follower.id, target.id, target.locked, options);
  if (followed.isErr()) {
    return err(followed.error);
  }
  await notifyNewFollow(env, follower.id, target.id, followed.value);
  return ok(true);
};
