import type { SensitiveValue } from "@tstodon/core";
import { InstanceIdentity } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountById } from "./account-store";
import { actorDeleteActivity } from "./activitypub";
import { type RepositoryError, toRepositoryError } from "./d1";
import { enqueueDepartedAccountActivity } from "./delivery";
import { newEntityId } from "./ids";
import {
  listAcceptedRemoteFollowerInboxes,
  listKnownRemoteInboxes,
  listOutboundFollowInboxes,
} from "./remote-actor-store";
import { parseInstanceIdentity } from "./runtime-config";

/*
 * The `Delete` of a deleted local account's actor, as Mastodon's
 * `DeleteAccountService#delete_actor!`. Mastodon marks the account deleted
 * and then sends; here the rows are gone once the account is deleted. So
 * what the `Delete` needs is read before the deletion, and the `Delete` is
 * queued only after the deletion committed: a deletion that fails part way
 * tells no remote server anything, and can be tried again.
 */

/**
 * The most inboxes one account's `Delete` goes to. Mastodon sends it to
 * every inbox it knows; here the targets are stored in the request that
 * deletes the account (100 a D1 batch) and delivered by the delivery
 * Workflow ten a step, so the number is capped.
 */
export const ACTOR_DELETE_INBOX_LIMIT = 1000;

/**
 * The inboxes a `Delete` goes to, at most `limit`: `related` first (the
 * account's followers and the accounts it follows, which hold a follow that
 * must end), then the `known` inboxes not among them.
 */
export const actorDeleteInboxes = (
  related: ReadonlyArray<string>,
  known: ReadonlyArray<string>,
  limit: number,
): string[] => [...new Set([...related, ...known])].slice(0, limit);

/** What is left of a local account to announce its deletion with. */
export type DepartingActor = Readonly<{
  actorUri: string;
  username: string;
  privateKeyJwk: SensitiveValue<string>;
  /** The inboxes to tell, shared inboxes where there are any. */
  inboxes: ReadonlyArray<string>;
}>;

/**
 * Read, while the account's rows still exist, what its `Delete` needs: its
 * name, its key, and the inboxes to tell. As Mastodon's
 * `DeleteAccountService` these are the inboxes of its remote followers and,
 * to be sure a server that holds a post, a mention or a boost of it hears
 * too, every other inbox this server knows, up to
 * {@link ACTOR_DELETE_INBOX_LIMIT}. A server that never heard of the account
 * asks for its actor and reads 410. An account no remote follows and that
 * follows no remote sends nothing: it never federated. `undefined` when
 * there is no such account.
 */
export const readDepartingActor = async (
  env: Env,
  accountId: string,
): Promise<Result<DepartingActor | undefined, RepositoryError>> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return err(toRepositoryError("invalid instance identity"));
  }
  const account = await findAccountById(env.DB, accountId);
  if (account.isErr()) {
    return err(account.error);
  }
  if (!account.value) {
    return ok(undefined);
  }
  const [followers, followed] = await Promise.all([
    listAcceptedRemoteFollowerInboxes(env.DB, accountId),
    listOutboundFollowInboxes(env.DB, accountId),
  ]);
  if (followers.isErr()) {
    return err(followers.error);
  }
  if (followed.isErr()) {
    return err(followed.error);
  }
  const related = [...followers.value, ...followed.value];
  const known =
    related.length === 0 ? ok([]) : await listKnownRemoteInboxes(env.DB, ACTOR_DELETE_INBOX_LIMIT);
  if (known.isErr()) {
    return err(known.error);
  }
  return ok({
    actorUri: InstanceIdentity.actorUrl(identity.value, account.value.username),
    username: account.value.username,
    privateKeyJwk: account.value.privateKeyJwk,
    inboxes: actorDeleteInboxes(related, known.value, ACTOR_DELETE_INBOX_LIMIT),
  });
};

/**
 * Queue the `Delete` of an account that has just been deleted, signed with
 * the key read before. Each remote then drops the account, its posts and its
 * follows. Best effort: the account is gone either way, and a `Delete` that
 * could not be queued is logged (`ActorDeleteNotFederated`).
 */
export const announceActorDeleted = async (env: Env, actor: DepartingActor): Promise<void> => {
  const enqueued = await enqueueDepartedAccountActivity(
    env,
    { kind: "DepartedAccount", username: actor.username, privateKeyJwk: actor.privateKeyJwk },
    "Delete",
    actorDeleteActivity(actor.actorUri, newEntityId()),
    actor.inboxes,
  );
  if (enqueued.isErr()) {
    console.error(
      JSON.stringify({
        kind: "ActorDeleteNotFederated",
        actor: actor.actorUri,
        inboxes: actor.inboxes.length,
        error: enqueued.error.kind,
      }),
    );
  }
};
