import {
  ActivityId,
  InstanceIdentity,
  OutboxJob,
  type OutboxJob as OutboxJobValue,
} from "@tstodon/domain";
import { findAccountById } from "./account-store";
import { signInboxRequest } from "./http-signature";
import {
  findOutboundActivity,
  insertOutboundActivity,
  markOutboundExpanded,
} from "./outbox-store";
import { listAcceptedFollowerIds } from "./social-store";
import { parseInstanceIdentity } from "./runtime-config";

export const enqueueLocalActivity = async (
  env: Env,
  accountId: string,
  kind: string,
  payload: unknown,
): Promise<void> => {
  const inserted = await insertOutboundActivity(env.DB, {
    accountId,
    kind,
    payload,
  });
  if (inserted.isErr()) {
    return;
  }
  const activityId = ActivityId.parse(inserted.value.id);
  if (activityId.isErr()) {
    return;
  }
  await env.OUTBOX_PROCESS_QUEUE.send({
    kind: "ExpandFollowers",
    activityId: activityId.value,
  });
};

export const processOutboxJob = async (
  env: Env,
  job: OutboxJobValue,
): Promise<void> => {
  switch (job.kind) {
    case "ProcessExpiredPolls":
      return;
    case "ExpandFollowers": {
      const activity = await findOutboundActivity(env.DB, job.activityId);
      if (activity.isErr() || !activity.value) {
        return;
      }
      const followerIds = await listAcceptedFollowerIds(
        env.DB,
        activity.value.account_id,
      );
      const identity = parseInstanceIdentity(env);
      const remoteTargets: string[] = [];
      if (followerIds.isOk() && identity.isOk()) {
        for (const followerId of followerIds.value) {
          const follower = await findAccountById(env.DB, followerId);
          if (follower.isErr() || !follower.value) {
            continue;
          }
          const inbox = `${InstanceIdentity.actorUrl(identity.value, follower.value.username)}/inbox`;
          remoteTargets.push(inbox);
        }
      }
      const sameHost = identity.isOk() ? identity.value.domain : "";
      const remoteInboxes = remoteTargets.filter((inbox) => {
        try {
          return new URL(inbox).host !== sameHost;
        } catch {
          return false;
        }
      });
      await markOutboundExpanded(env.DB, job.activityId, remoteInboxes.length);
      for (const inboxUrl of remoteInboxes) {
        const parsedInbox = OutboxJob.parse({
          kind: "DeliverTarget",
          activityId: job.activityId,
          inboxUrl,
        });
        if (parsedInbox.isOk()) {
          await env.OUTBOX_PROCESS_QUEUE.send(parsedInbox.value);
        }
      }
      return;
    }
    case "DeliverTarget": {
      const activity = await findOutboundActivity(env.DB, job.activityId);
      if (activity.isErr() || !activity.value) {
        return;
      }
      const account = await findAccountById(env.DB, activity.value.account_id);
      if (account.isErr() || !account.value) {
        return;
      }
      const identity = parseInstanceIdentity(env);
      if (identity.isErr()) {
        return;
      }
      const inbox = new URL(job.inboxUrl);
      const keyId = `${InstanceIdentity.actorUrl(identity.value, account.value.username)}#main-key`;
      const headers = await signInboxRequest(
        inbox,
        account.value.privateKeyJwk.unwrap(),
        keyId,
        activity.value.payload_json,
      );
      if (headers.isErr()) {
        return;
      }
      await fetch(inbox, {
        method: "POST",
        headers: headers.value,
        body: activity.value.payload_json,
      });
    }
  }
};
