import {
  AccountId,
  ActivityId,
  FORWARD_MAX_ACCOUNTS,
  type InstanceIdentity,
  type OutboxJob as OutboxJobValue,
  RemoteActor,
  type RemoteStatus,
} from "@tstodon/domain";
import { deliverExpandedActivity } from "./delivery";
import { forwardableBody } from "./ld-signature";
import { writeMetric } from "./metrics";
import type { OutboxJobOutcome } from "./outbox-job";
import { findOutboundActivity, insertOutboundActivity } from "./outbox-store";
import { listAcceptedRemoteFollowerInboxesOf } from "./remote-actor-store";
import { remoteActivityForward } from "./status-reach";
import { statusReachOperations } from "./status-reach-operations";

/** An inbound activity about a remote status, as received. */
export type ReceivedActivity = Readonly<{ kind: "Create" | "Update" | "Delete"; body: unknown }>;

const logNotForwarded = (status: RemoteStatus, step: string, message: string): void => {
  console.error(
    JSON.stringify({ kind: "ActivityNotForwarded", statusId: status.id, step, message }),
  );
};

/**
 * Forward `activity`, which `author` sent about its status `status`, to the
 * local audience that would miss it (`remoteActivityForward`): Mastodon's
 * `Create#forward_for_reply`, and `ActivityPub::Forwarder` for an `Update`
 * or a `Delete`. The body goes as received, and only one that carries its
 * actor's Linked Data signature: the receivers check that signature, ours
 * only signs the request. The inboxes are listed by an `ExpandForward` job.
 * Best effort: the activity is applied here whether or not this fails.
 */
export const forwardRemoteActivity = async (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatus,
  author: RemoteActor,
  activity: ReceivedActivity,
): Promise<void> => {
  const body = forwardableBody(activity.body);
  if (body === undefined) {
    return;
  }
  const plan = await remoteActivityForward(statusReachOperations(env, identity), {
    kind: "Remote",
    status,
  });
  if (plan.isErr()) {
    logNotForwarded(status, "plan", plan.error.message);
    return;
  }
  if (plan.value === undefined) {
    return;
  }
  const followersOf = plan.value.followersOf
    .slice(0, FORWARD_MAX_ACCOUNTS)
    .map((id) => AccountId.parse(id))
    .flatMap((id) => (id.isOk() ? [id.value] : []));
  const inserted = await insertOutboundActivity(env.DB, {
    signer: { kind: "Account", accountId: plan.value.signerAccountId },
    kind: activity.kind,
    payload: body,
    audience: "Followers",
  });
  if (inserted.isErr()) {
    logNotForwarded(status, "insert", inserted.error.message);
    return;
  }
  const activityId = ActivityId.parse(inserted.value.id);
  if (activityId.isErr() || followersOf.length === 0) {
    logNotForwarded(status, "insert", "invalid activity or account id");
    return;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send({
      kind: "ExpandForward",
      activityId: activityId.value,
      followersOf,
      exceptInboxes: [RemoteActor.deliveryInbox(author)],
    });
  } catch (cause) {
    logNotForwarded(status, "queue", cause instanceof Error ? cause.message : String(cause));
    return;
  }
  writeMetric(env, "outbox.enqueue", [1], [activity.kind, "forward"]);
};

/**
 * Deliver a forward to the remote followers of the job's accounts, without
 * the actor's own inbox, as Mastodon's `Forwarder#inboxes`.
 */
export const processExpandForwardJob = async (
  env: Env,
  job: Extract<OutboxJobValue, { kind: "ExpandForward" }>,
): Promise<OutboxJobOutcome> => {
  const startedAt = Date.now();
  const activity = await findOutboundActivity(env.DB, job.activityId);
  if (activity.isErr() || !activity.value) {
    return "ok";
  }
  const inboxes = await listAcceptedRemoteFollowerInboxesOf(env.DB, job.followersOf);
  if (inboxes.isErr()) {
    return "retry";
  }
  const except = new Set(job.exceptInboxes);
  await deliverExpandedActivity(
    env,
    job.activityId,
    inboxes.value.filter((inbox) => !except.has(inbox)),
    startedAt,
  );
  return "ok";
};
