import type { Context } from "hono";
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import type { FediRole } from "@tstodon/domain";
import { isBlockedFederatedHost } from "../federated-fetch";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readNestedBody,
  requireSession,
} from "../http";
import {
  deletePushSubscription,
  findLatestPushSubscription,
  noAlerts,
  PUSH_ALERT_KEYS,
  PushPolicySchema,
  updatePushSubscriptionData,
  upsertPushSubscription,
  type PushAlerts,
  type PushPolicy,
  type PushSubscription,
} from "../push-subscription-store";
import { parseInstanceIdentity } from "../runtime-config";
import { isTruthy } from "../form-values";
import { base64UrlToBytes, vapidPublicKey } from "../vapid";

/**
 * Web Push subscriptions (`/api/v1/push/subscription`). Mastodon keeps one per
 * access token; tstodon tokens have no identity of their own, so the account
 * holds one per push endpoint and these routes address its most recently
 * created or updated subscription.
 */

const booleanish = z.union([z.boolean(), z.string(), z.number()]);

const PushDataSchema = z.object({
  alerts: z.record(z.string(), booleanish).optional(),
  policy: z.string().optional(),
});

const PushCreateBodySchema = z.object({
  subscription: z.object({
    endpoint: z.string().trim().min(1),
    keys: z.object({ p256dh: z.string().trim().min(1), auth: z.string().trim().min(1) }),
    standard: booleanish.optional(),
  }),
  data: PushDataSchema.optional(),
});

/** `PUT` takes the alerts under `data`, and `policy` either there or top-level. */
const PushUpdateBodySchema = z.object({
  data: PushDataSchema.optional(),
  policy: z.string().optional(),
});

const notFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

const unprocessable = (c: Context<{ Bindings: Env }>, error: string) =>
  c.json({ error, kind: "ValidationError" }, 422);

/** Requested alerts; keys left out are off, and admin alerts need an admin. */
const alertsFrom = (
  requested: Readonly<Record<string, boolean | string | number>> | undefined,
  role: FediRole,
): PushAlerts => {
  const alerts = noAlerts();
  for (const key of PUSH_ALERT_KEYS) {
    const adminOnly = key.startsWith("admin.");
    alerts[key] = (!adminOnly || role.kind === "Admin") && isTruthy(requested?.[key]);
  }
  return alerts;
};

const policyFrom = (raw: string | undefined): PushPolicy | undefined => {
  if (raw === undefined || raw.trim().length === 0) {
    return "all";
  }
  const parsed = schemaResult(PushPolicySchema)(raw.trim());
  return parsed.isOk() ? parsed.value : undefined;
};

const decodedLength = (value: string): number | undefined => {
  try {
    return base64UrlToBytes(value).length;
  } catch {
    return undefined;
  }
};

/** An uncompressed P-256 point (65 bytes, leading 0x04) and a 16-byte auth secret. */
const validKeys = (p256dh: string, auth: string): boolean => {
  if (decodedLength(auth) !== 16 || decodedLength(p256dh) !== 65) {
    return false;
  }
  return base64UrlToBytes(p256dh)[0] === 0x04;
};

const subscriptionDocument = (env: Env, subscription: PushSubscription) => ({
  id: subscription.id,
  endpoint: subscription.endpoint,
  standard: subscription.standard,
  alerts: subscription.alerts,
  policy: subscription.policy,
  server_key: vapidPublicKey(env),
});

export const postV1PushSubscription = async (
  c: Context<{ Bindings: Env }, "/api/v1/push/subscription">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const session = await requireSession(c);
  if (session.isErr()) {
    return jsonAuthError(c, session.error);
  }
  const body = await readNestedBody(c, PushCreateBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const { endpoint, keys, standard } = body.value.subscription;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return unprocessable(c, "Validation failed: Endpoint is invalid");
  }
  // Push services are ordinary public hosts; the federation allow list does
  // not apply to them, but private and local addresses are refused.
  if (url.protocol !== "https:" || isBlockedFederatedHost(url.hostname, identity.value.domain)) {
    return unprocessable(c, "Validation failed: Endpoint is invalid");
  }
  if (!validKeys(keys.p256dh, keys.auth)) {
    return unprocessable(c, "Validation failed: Keys are invalid");
  }
  const policy = policyFrom(body.value.data?.policy);
  if (!policy) {
    return unprocessable(c, "Validation failed: Policy is not included in the list");
  }
  const stored = await upsertPushSubscription(c.env.DB, {
    accountId: session.value.account.id,
    endpoint: url.toString(),
    p256dh: keys.p256dh,
    auth: keys.auth,
    standard: isTruthy(standard),
    alerts: alertsFrom(body.value.data?.alerts, session.value.role),
    policy,
  });
  if (stored.isErr()) {
    return jsonRepositoryError(c, stored.error.message);
  }
  return stored.value ? c.json(subscriptionDocument(c.env, stored.value)) : notFound(c);
};

export const getV1PushSubscription = async (
  c: Context<{ Bindings: Env }, "/api/v1/push/subscription">,
) => {
  const session = await requireSession(c);
  if (session.isErr()) {
    return jsonAuthError(c, session.error);
  }
  const found = await findLatestPushSubscription(c.env.DB, session.value.account.id);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  return found.value ? c.json(subscriptionDocument(c.env, found.value)) : notFound(c);
};

/** Only the alerts and policy change; as in Mastodon, alerts left out turn off. */
export const putV1PushSubscription = async (
  c: Context<{ Bindings: Env }, "/api/v1/push/subscription">,
) => {
  const session = await requireSession(c);
  if (session.isErr()) {
    return jsonAuthError(c, session.error);
  }
  const body = await readNestedBody(c, PushUpdateBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const policy = policyFrom(body.value.data?.policy ?? body.value.policy);
  if (!policy) {
    return unprocessable(c, "Validation failed: Policy is not included in the list");
  }
  const accountId = session.value.account.id;
  const current = await findLatestPushSubscription(c.env.DB, accountId);
  if (current.isErr()) {
    return jsonRepositoryError(c, current.error.message);
  }
  if (!current.value) {
    return notFound(c);
  }
  const updated = await updatePushSubscriptionData(
    c.env.DB,
    accountId,
    current.value.id,
    alertsFrom(body.value.data?.alerts, session.value.role),
    policy,
  );
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }
  return updated.value ? c.json(subscriptionDocument(c.env, updated.value)) : notFound(c);
};

/** Removes the most recent subscription; succeeds when there is none. */
export const deleteV1PushSubscription = async (
  c: Context<{ Bindings: Env }, "/api/v1/push/subscription">,
) => {
  const session = await requireSession(c);
  if (session.isErr()) {
    return jsonAuthError(c, session.error);
  }
  const current = await findLatestPushSubscription(c.env.DB, session.value.account.id);
  if (current.isErr()) {
    return jsonRepositoryError(c, current.error.message);
  }
  if (current.value) {
    const removed = await deletePushSubscription(c.env.DB, current.value.id);
    if (removed.isErr()) {
      return jsonRepositoryError(c, removed.error.message);
    }
  }
  return c.json({});
};
