import { err, ok, type Result } from "neverthrow";
import { findAccountsByIds } from "./account-store";
import type { RepositoryError } from "./d1";
import { notifyAccount } from "./notify";
import { sendFollowUndo } from "./outbound-follow";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { sendFollowReject } from "./remote-follower";
import { parseInstanceIdentity } from "./runtime-config";
import {
  type AccountSeveranceEvent,
  type SeveranceInput,
  type SeveredScope,
  severRelationships,
} from "./severed-relationship-store";

/**
 * Tell each local account what it lost with a `severed_relationships`
 * notification. The notification is from the account to itself, as
 * Mastodon's is. Each account is notified independently: a failed delivery
 * does not keep the rest from theirs, and the first failure is the one
 * reported.
 */
export const notifySeverance = async (
  env: Env,
  events: ReadonlyArray<AccountSeveranceEvent>,
): Promise<Result<void, RepositoryError>> => {
  const notified = await Promise.all(
    events.map((event) =>
      notifyAccount(env, {
        accountId: event.accountId,
        fromAccountId: event.accountId,
        kind: "severed_relationships",
        severanceEventId: event.id,
      }),
    ),
  );
  const failed = notified.find((result) => result.isErr());
  return failed?.isErr() ? err(failed.error) : ok(undefined);
};

/**
 * Tell the suspended server of the follows removed, as Mastodon's
 * `DeleteAccountService` does for each account of a domain it suspends: a
 * `Reject(Follow)` for each of its actors' follows (`reject_follows!`) and
 * an `Undo(Follow)` for each local account's follow of one
 * (`undo_follows!`), delivered though the domain is suspended. Best effort,
 * as for any unfollow: the follows are gone, so a retry would find nothing
 * to send.
 */
const announceRemoval = async (env: Env, severed: SeveredScope): Promise<void> => {
  const identity = parseInstanceIdentity(env);
  const [accounts, actors] = await Promise.all([
    findAccountsByIds(env.DB, [
      ...severed.unfollowed.map((follow) => follow.accountId),
      ...severed.rejected.map((follow) => follow.accountId),
    ]),
    findRemoteActorsByUris(env.DB, [
      ...severed.unfollowed.map((follow) => follow.actorUri),
      ...severed.rejected.map((follow) => follow.actorUri),
    ]),
  ]);
  if (identity.isErr() || accounts.isErr() || actors.isErr()) {
    console.error(JSON.stringify({ kind: "DomainSuspensionSeveranceNotAnnounced" }));
    return;
  }
  for (const follow of severed.rejected) {
    const account = accounts.value.get(follow.accountId);
    const actor = actors.value.get(follow.actorUri);
    if (account && actor) {
      await sendFollowReject(
        env,
        identity.value,
        account,
        actor,
        follow.followActivityId ?? actor.actorUri,
        "AlsoSuspended",
      );
    }
  }
  for (const follow of severed.unfollowed) {
    const account = accounts.value.get(follow.accountId);
    const actor = actors.value.get(follow.actorUri);
    if (account && actor && follow.followActivityId !== null) {
      await sendFollowUndo(
        env,
        identity.value,
        account,
        actor,
        follow.followActivityId,
        "AlsoSuspended",
      );
    }
  }
};

/**
 * Remove the follows a domain suspension cuts, record them, notify each
 * account, and tell the suspended server.
 */
export const severAndNotify = async (
  env: Env,
  input: SeveranceInput,
): Promise<Result<void, RepositoryError>> => {
  const severed = await severRelationships(env.DB, input);
  if (severed.isErr()) {
    return err(severed.error);
  }
  const notified = await notifySeverance(env, severed.value.events);
  await announceRemoval(env, severed.value);
  return notified;
};
