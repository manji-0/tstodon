import {
  ActivityId,
  FORWARD_PAGE_ACCOUNTS,
  type InstanceIdentity,
  type OutboxJob as OutboxJobValue,
  RemoteActor,
  type RemoteStatus,
  type ThreadStatus,
} from "@tstodon/domain";
import { ok } from "neverthrow";
import { deliverExpandedActivity, storeExpandedPage } from "./delivery";
import { suspendedDomains } from "./admin-domain-block-store";
import { deleteForwardAudience, listForwardAudiencePage } from "./forward-audience-store";
import { remoteContextsFor } from "./jsonld-remote-contexts";
import { forwardableBody, forwardsAsRead } from "./ld-signature";
import { federationAllowHosts } from "./runtime-config";
import { writeMetric } from "./metrics";
import type { OutboxJobOutcome } from "./outbox-job";
import { findOutboundActivity, insertForwardedActivity } from "./outbox-store";
import { listAcceptedRemoteFollowerInboxesOf } from "./remote-actor-store";
import { distributable, remoteActivityForward } from "./status-reach";
import { statusReachOperations, statusTargetOf } from "./status-reach-operations";

type ExpandForwardJob = Extract<OutboxJobValue, { kind: "ExpandForward" }>;

/** An inbound activity about a status, as received. */
export type ReceivedActivity = Readonly<{ kind: "Create" | "Update" | "Delete"; body: unknown }>;

const logNotForwarded = (status: ThreadStatus, step: string, message: string): void => {
  console.error(
    JSON.stringify({ kind: "ActivityNotForwarded", statusId: status.status.id, step, message }),
  );
};

/**
 * Forward `activity`, which `author` sent about its status `status`, as
 * Mastodon's `Create#forward_for_reply`, and `ActivityPub::Forwarder` for an
 * `Update` or a `Delete`: only for a public or unlisted status
 * (`Forwarder#forwardable?`), to {@link forwardInboundActivity}'s audience.
 */
export const forwardRemoteActivity = async (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatus,
  author: RemoteActor,
  activity: ReceivedActivity,
): Promise<void> => {
  const thread: ThreadStatus = { kind: "Remote", status };
  if (distributable(thread)) {
    await forwardInboundActivity(env, identity, thread, author, activity);
  }
};

/**
 * Forward `activity`, which `sender` sent about `status`, to the local
 * audience that would miss it (`remoteActivityForward`), whatever the
 * status's visibility: `Delete#revoke_quote` calls `ActivityPub::Forwarder`
 * for the quoting status without asking `forwardable?`. The body goes as
 * received, and only one that carries a Linked Data signature: the receivers
 * check that signature, ours only signs the request. The inboxes are listed
 * by an `ExpandForward` job. Best effort: the activity is applied here
 * whether or not this fails.
 */
export const forwardInboundActivity = async (
  env: Env,
  identity: InstanceIdentity,
  status: ThreadStatus,
  sender: RemoteActor,
  activity: ReceivedActivity,
): Promise<void> => {
  const body = forwardableBody(activity.body);
  if (body === undefined) {
    return;
  }
  const forwardOf = body["id"];
  if (typeof forwardOf !== "string") {
    return;
  }
  const plan = await remoteActivityForward(statusReachOperations(env, identity), status);
  if (plan.isErr()) {
    logNotForwarded(status, "plan", plan.error.message);
    return;
  }
  if (plan.value === undefined) {
    return;
  }
  // Checked only once there is someone to forward to; a context the body
  // names was fetched and kept when the inbound check read it.
  const [allowHosts, blockedHosts] = await Promise.all([
    federationAllowHosts(env),
    suspendedDomains(env.DB),
  ]);
  if (
    !(await forwardsAsRead(body, remoteContextsFor(env.DB, identity, { allowHosts, blockedHosts })))
  ) {
    console.warn(JSON.stringify({ kind: "ForwardRefused", statusId: status.status.id, forwardOf }));
    return;
  }
  const inserted = await insertForwardedActivity(env.DB, {
    accountId: plan.value.signerAccountId,
    kind: activity.kind,
    payloadJson: JSON.stringify(body),
    forwardOf,
    audience: {
      target: statusTargetOf(status),
      repliedToAccountId: plan.value.repliedToAccountId,
    },
  });
  if (inserted.isErr()) {
    logNotForwarded(status, "insert", inserted.error.message);
    return;
  }
  // Expanded by an earlier try of this delivery. One that stored the row
  // but failed to queue its expansion is queued again here.
  if (inserted.value === undefined) {
    return;
  }
  const activityId = ActivityId.parse(inserted.value);
  if (activityId.isErr()) {
    logNotForwarded(status, "insert", "invalid activity id");
    return;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send({
      kind: "ExpandForward",
      activityId: activityId.value,
      afterAccountId: "",
      targets: 0,
      exceptInboxes: [RemoteActor.deliveryInbox(sender)],
    } satisfies ExpandForwardJob);
  } catch (cause) {
    logNotForwarded(status, "queue", cause instanceof Error ? cause.message : String(cause));
    return;
  }
  writeMetric(env, "outbox.enqueue", [1], [activity.kind, "forward"]);
};

/**
 * Deliver a forward to the remote followers of the next page of its
 * audience, without the actor's own inbox, as Mastodon's `Forwarder#inboxes`.
 * A full page stores its targets and queues the next page; the last one
 * starts the delivery and forgets the audience. Each job reads the
 * followers of at most `FORWARD_PAGE_ACCOUNTS` accounts.
 */
export const processExpandForwardJob = async (
  env: Env,
  job: ExpandForwardJob,
): Promise<OutboxJobOutcome> => {
  const startedAt = Date.now();
  const activity = await findOutboundActivity(env.DB, job.activityId);
  if (activity.isErr()) {
    return "retry";
  }
  if (!activity.value) {
    return "ok";
  }
  const page = await listForwardAudiencePage(
    env.DB,
    job.activityId,
    job.afterAccountId,
    FORWARD_PAGE_ACCOUNTS,
  );
  if (page.isErr()) {
    return "retry";
  }
  const inboxes =
    page.value.length === 0
      ? ok([])
      : await listAcceptedRemoteFollowerInboxesOf(env.DB, page.value);
  if (inboxes.isErr()) {
    return "retry";
  }
  const except = new Set(job.exceptInboxes);
  const candidates = inboxes.value.filter((inbox) => !except.has(inbox));
  const last = page.value.at(-1);
  if (page.value.length === FORWARD_PAGE_ACCOUNTS && last !== undefined) {
    const stored = await storeExpandedPage(env, job.activityId, candidates);
    if (stored.isErr()) {
      return "retry";
    }
    const next: ExpandForwardJob = {
      ...job,
      afterAccountId: last,
      targets: job.targets + stored.value,
    };
    try {
      await env.OUTBOX_PROCESS_QUEUE.send(next);
    } catch {
      return "retry";
    }
    return "ok";
  }
  await deliverExpandedActivity(env, job.activityId, candidates, startedAt, job.targets);
  await deleteForwardAudience(env.DB, job.activityId);
  return "ok";
};
