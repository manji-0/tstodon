import { schemaResult } from "@tstodon/core";
import type { OutboxJob } from "@tstodon/domain";
import { z } from "zod";
import { htmlToText } from "./html";
import { mastodonNotification } from "./notification-documents";
import { writeMetric } from "./metrics";
import {
  deletePushSubscription,
  listPushSubscriptions,
  PUSH_ALERT_KEYS,
  type PushAlertKey,
  type PushSubscription,
} from "./push-subscription-store";
import { RemoteAccountId } from "./remote-account-id";
import { findRemoteFollow } from "./remote-actor-store";
import { parseInstanceIdentity } from "./runtime-config";
import { findFollowKind } from "./follow-store";
import { findNotificationById } from "./notification-store";
import { vapidKeys } from "./vapid";
import { buildPushRequest } from "./web-push";

/** Push services may hold an undelivered message this long (Mastodon uses two days). */
const PUSH_TTL_SECONDS = 48 * 60 * 60;

const BODY_LIMIT = 140;

/** Mastodon's English push titles (`notification_mailer.<type>.subject`). */
const TITLES: Readonly<Record<PushAlertKey, (name: string) => string>> = {
  mention: (name) => `${name} mentioned you`,
  quote: (name) => `${name} quoted your post`,
  status: (name) => `${name} just posted`,
  reblog: (name) => `${name} boosted your post`,
  follow: (name) => `${name} is now following you`,
  follow_request: (name) => `Pending follower: ${name}`,
  favourite: (name) => `${name} favorited your post`,
  poll: (name) => `A poll by ${name} has ended`,
  update: (name) => `${name} edited a post`,
  quoted_update: (name) => `${name} edited a post you have quoted`,
  "admin.sign_up": (name) => `${name} signed up`,
  "admin.report": (name) => `New report from ${name}`,
};

const alertKeyOf = (kind: string): PushAlertKey | undefined =>
  PUSH_ALERT_KEYS.find((key) => key === kind);

/** Queue one push per subscription once a notification is delivered; no-op without VAPID. */
export const enqueuePushDeliveries = async (
  env: Env,
  accountId: string,
  notificationId: string,
): Promise<void> => {
  if (!vapidKeys(env)) {
    return;
  }
  const subscriptions = await listPushSubscriptions(env.DB, accountId);
  if (subscriptions.isErr() || subscriptions.value.length === 0) {
    return;
  }
  await env.OUTBOX_PROCESS_QUEUE.sendBatch(
    subscriptions.value.map((subscription) => ({
      body: {
        kind: "DeliverPush",
        accountId,
        notificationId,
        subscriptionId: subscription.id,
      } satisfies OutboxJob,
    })),
  );
};

/** Does the subscription's `policy` let this sender's notifications through? */
const policyAdmits = async (
  db: D1Database,
  subscription: PushSubscription,
  senderId: string,
): Promise<boolean | undefined> => {
  switch (subscription.policy) {
    case "all":
      return true;
    case "none":
      return false;
    // Local accounts cannot follow remote ones here, so `followed` never admits a remote sender.
    case "followed": {
      const kind = await findFollowKind(db, subscription.accountId, senderId);
      return kind.isOk() ? kind.value === "Accepted" : undefined;
    }
    case "follower": {
      // A remote sender follows through `remote_follows`, keyed by actor URI.
      const actorUri = RemoteAccountId.decode(senderId);
      if (actorUri.isOk()) {
        const follow = await findRemoteFollow(db, subscription.accountId, actorUri.value);
        return follow.isOk() ? follow.value?.requestKind === "Fulfilled" : undefined;
      }
      const kind = await findFollowKind(db, senderId, subscription.accountId);
      return kind.isOk() ? kind.value === "Accepted" : undefined;
    }
  }
};

const RenderedNotificationSchema = z.object({
  account: z.object({
    username: z.string(),
    display_name: z.string().optional(),
    avatar: z.string().optional(),
    note: z.string().optional(),
  }),
  status: z
    .object({ content: z.string().optional(), spoiler_text: z.string().optional() })
    .nullable()
    .optional(),
});

const truncate = (text: string): string =>
  text.length <= BODY_LIMIT ? text : `${text.slice(0, BODY_LIMIT - 1)}…`;

/**
 * Mastodon's push payload. `access_token` is left out: tokens here are
 * short-lived Access JWTs with no per-client identity to hand back.
 */
const pushPayload = (
  notificationId: string,
  type: PushAlertKey,
  document: z.infer<typeof RenderedNotificationSchema>,
): Record<string, unknown> => {
  const displayName = document.account.display_name?.trim() ?? "";
  const name = displayName.length > 0 ? displayName : document.account.username;
  const spoiler = document.status?.spoiler_text?.trim() ?? "";
  const text =
    spoiler.length > 0
      ? spoiler
      : htmlToText(document.status?.content ?? document.account.note ?? "");
  return {
    notification_id: notificationId,
    notification_type: type,
    preferred_locale: "en",
    icon: document.account.avatar ?? null,
    title: TITLES[type](name),
    body: truncate(text),
  };
};

/**
 * Queue handler: encrypt and send one notification to one subscription.
 * A gone subscription (404/410) is deleted; 429 and 5xx are retried.
 */
export const processPushJob = async (
  env: Env,
  job: Extract<OutboxJob, { kind: "DeliverPush" }>,
): Promise<"ok" | "retry"> => {
  const vapid = vapidKeys(env);
  const identity = parseInstanceIdentity(env);
  if (!vapid || identity.isErr()) {
    return "ok";
  }
  const subscriptions = await listPushSubscriptions(env.DB, job.accountId);
  if (subscriptions.isErr()) {
    return "retry";
  }
  const subscription = subscriptions.value.find((entry) => entry.id === job.subscriptionId);
  if (!subscription) {
    return "ok";
  }
  const row = await findNotificationById(env.DB, job.accountId, job.notificationId);
  if (row.isErr()) {
    return "retry";
  }
  const type = row.value ? alertKeyOf(row.value.kind) : undefined;
  if (!row.value || !type || !subscription.alerts[type]) {
    return "ok";
  }
  const admitted = await policyAdmits(env.DB, subscription, row.value.from_account_id);
  if (admitted === undefined) {
    return "retry";
  }
  if (!admitted) {
    return "ok";
  }
  const rendered = await mastodonNotification(env, identity.value, row.value, job.accountId);
  const document = schemaResult(RenderedNotificationSchema)(rendered);
  if (document.isErr()) {
    return "ok";
  }
  const request = await buildPushRequest(
    vapid,
    vapid.subject ?? identity.value.publicOrigin,
    subscription,
    JSON.stringify(pushPayload(job.notificationId, type, document.value)),
    PUSH_TTL_SECONDS,
  );
  let response: Response;
  try {
    response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    writeMetric(env, "push.deliver", [0], ["network"]);
    return "retry";
  }
  writeMetric(env, "push.deliver", [response.status], [String(response.status)]);
  if (response.status === 404 || response.status === 410) {
    await deletePushSubscription(env.DB, subscription.id);
    return "ok";
  }
  if (response.status === 429 || response.status >= 500) {
    return "retry";
  }
  return "ok";
};
