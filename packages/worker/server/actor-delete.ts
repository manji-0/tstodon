import { InstanceIdentity } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountById } from "./account-store";
import { actorDeleteActivity } from "./activitypub";
import { type RepositoryError, toRepositoryError } from "./d1";
import {
  admittedInboxes,
  logSkippedTargets,
  partitionByDomainAvailability,
  startOutboxDeliveryWorkflow,
} from "./delivery";
import { newEntityId } from "./ids";
import { ldSignedActivity, ldSignsNow } from "./own-activity-signature";
import { writeMetric } from "./metrics";
import type { DepartedAccountActivity } from "./outbox-store";
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
 * stored in the batch that deletes the account
 * (`departedAccountActivityStatements`): a deletion that fails part way
 * tells no remote server anything, and can be tried again, and one that
 * commits has its `Delete` stored. Its delivery starts after the commit.
 */

/**
 * The most inboxes one account's `Delete` goes to beyond its followers' and
 * its follows'. Mastodon sends it to every inbox it knows; here the targets
 * are stored in the request that deletes the account and delivered by the
 * delivery Workflow ten a step, so the inboxes with no tie to the account
 * are capped. Those of its followers and follows never are: each holds a
 * follow that must end.
 */
export const ACTOR_DELETE_INBOX_LIMIT = 1000;

/**
 * The inboxes a `Delete` goes to: every one of `related` (the account's
 * followers and the accounts it follows), then the `known` inboxes not among
 * them, as many as fit under `limit`.
 */
export const actorDeleteInboxes = (
  related: ReadonlyArray<string>,
  known: ReadonlyArray<string>,
  limit: number,
): string[] => {
  const inboxes = new Set(related);
  const room = Math.max(0, limit - inboxes.size);
  return [...inboxes, ...known.filter((inbox) => !inboxes.has(inbox)).slice(0, room)];
};

/**
 * Read, while the account's rows still exist, its `Delete` with what it
 * needs: its name, its key, and the inboxes to tell. As Mastodon's
 * `DeleteAccountService` these are the inboxes of its remote followers and,
 * to be sure a server that holds a post, a mention or a boost of it hears
 * too, every other inbox this server knows, up to
 * {@link ACTOR_DELETE_INBOX_LIMIT}. A server that never heard of the account
 * asks for its actor and reads 410. An account no remote follows and that
 * follows no remote sends nothing: it never federated. An inbox this server
 * never contacts (a suspended domain, one outside the allow list) is left
 * out. `undefined` when there is no such account, or no inbox to tell.
 */
export const readDepartingActor = async (
  env: Env,
  accountId: string,
): Promise<Result<DepartedAccountActivity | undefined, RepositoryError>> => {
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
  const admitted = await admittedInboxes(
    env,
    actorDeleteInboxes(related, known.value, ACTOR_DELETE_INBOX_LIMIT),
  );
  if (admitted.length === 0) {
    return ok(undefined);
  }
  const { deliver, skipped } = await partitionByDomainAvailability(env.DB, admitted);
  const actorUri = InstanceIdentity.actorUrl(identity.value, account.value.username);
  // Mastodon signs it in any mode (`always_sign`), so a server that hears of
  // it from another can tell it is the actor's.
  const activity = actorDeleteActivity(actorUri, newEntityId());
  return ok({
    id: newEntityId(),
    username: account.value.username,
    privateKeyJwk: account.value.privateKeyJwk,
    kind: "Delete",
    payload: ldSignsNow(env, activity)
      ? await ldSignedActivity(identity.value, account.value, activity, new Date())
      : activity,
    deliver,
    skipped,
  });
};

/**
 * Start the delivery of the `Delete` of an account whose deletion has just
 * committed with the activity and its targets. A delivery that does not
 * start is logged (`OutboxWorkflowCreateFailed`), and the stuck-delivery
 * sweep starts it within the hour, as it finds the targets `Queued`.
 */
export const announceActorDeleted = async (
  env: Env,
  activity: DepartedAccountActivity,
): Promise<void> => {
  logSkippedTargets(env, activity.id, activity.skipped, "targeted");
  if (activity.deliver.length > 0) {
    await startOutboxDeliveryWorkflow(env, activity.id);
  }
  writeMetric(env, "outbox.enqueue", [1], [activity.kind, "targeted"]);
};
