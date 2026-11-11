import type { Context } from "hono";
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import type { ApiWebPushSubscriptionJSON } from "@tstodon/api";
import type { FediRole } from "@tstodon/domain";
import type { AuthenticatedSession } from "../auth";
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
  findTokenPushSubscription,
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
 * Web Push subscriptions (`/api/v1/push/subscription`). As in Mastodon, each
 * OAuth access token holds at most one: `POST` replaces it, `GET` / `PUT` /
 * `DELETE` address it, and revoking the token removes it. Notifications go to
 * every subscription of the account.
 */

const booleanish = z.union([z.boolean(), z.string(), z.number()]);

export const PushDataSchema = z.object({
  alerts: z.record(z.string(), booleanish).optional(),
  policy: z.string().optional(),
});

export const PushCreateBodySchema = z.object({
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

export const notFound = (c: Context<{ Bindings: Env }>) =>
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

/** `REST::PushSubscriptionSerializer`, the same shape as `REST::WebPushSubscriptionSerializer`. */
export const subscriptionDocument = (
  env: Env,
  subscription: PushSubscription,
): ApiWebPushSubscriptionJSON => ({
  id: subscription.id,
  endpoint: subscription.endpoint,
  standard: subscription.standard,
  alerts: subscription.alerts,
  policy: subscription.policy,
  server_key: vapidPublicKey(env),
});

/**
 * Subscribe the session's access token (replacing the subscription it holds):
 * shared by `POST /api/v1/push/subscription` and `POST /api/web/push_subscriptions`.
 */
export const createPushSubscription = async (
  c: Context<{ Bindings: Env }>,
  session: AuthenticatedSession,
  body: z.infer<typeof PushCreateBodySchema>,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const { endpoint, keys, standard } = body.subscription;
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
  const policy = policyFrom(body.data?.policy);
  if (!policy) {
    return unprocessable(c, "Validation failed: Policy is not included in the list");
  }
  const stored = await upsertPushSubscription(c.env.DB, {
    accessTokenId: session.token.id,
    accountId: session.account.id,
    endpoint: url.toString(),
    p256dh: keys.p256dh,
    auth: keys.auth,
    standard: isTruthy(standard),
    alerts: alertsFrom(body.data?.alerts, session.role),
    policy,
  });
  if (stored.isErr()) {
    return jsonRepositoryError(c, stored.error.message);
  }
  return stored.value ? c.json(subscriptionDocument(c.env, stored.value)) : notFound(c);
};

/**
 * Replace the alerts and policy of the token's subscription; as in Mastodon,
 * alerts left out turn off. Shared with `PUT /api/web/push_subscriptions/:id`.
 */
export const updatePushSubscription = async (
  c: Context<{ Bindings: Env }>,
  session: AuthenticatedSession,
  data:
    | Readonly<{ alerts?: Readonly<Record<string, boolean | string | number>> | undefined }>
    | undefined,
  rawPolicy: string | undefined,
) => {
  const policy = policyFrom(rawPolicy);
  if (!policy) {
    return unprocessable(c, "Validation failed: Policy is not included in the list");
  }
  const updated = await updatePushSubscriptionData(
    c.env.DB,
    session.token.id,
    alertsFrom(data?.alerts, session.role),
    policy,
  );
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }
  return updated.value ? c.json(subscriptionDocument(c.env, updated.value)) : notFound(c);
};

export const postV1PushSubscription = async (
  c: Context<{ Bindings: Env }, "/api/v1/push/subscription">,
) => {
  const session = await requireSession(c);
  if (session.isErr()) {
    return jsonAuthError(c, session.error);
  }
  const body = await readNestedBody(c, PushCreateBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  return createPushSubscription(c, session.value, body.value);
};

export const getV1PushSubscription = async (
  c: Context<{ Bindings: Env }, "/api/v1/push/subscription">,
) => {
  const session = await requireSession(c);
  if (session.isErr()) {
    return jsonAuthError(c, session.error);
  }
  const found = await findTokenPushSubscription(c.env.DB, session.value.token.id);
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
  return updatePushSubscription(
    c,
    session.value,
    body.value.data,
    body.value.data?.policy ?? body.value.policy,
  );
};

/** Removes the token's subscription; succeeds when there is none. */
export const deleteV1PushSubscription = async (
  c: Context<{ Bindings: Env }, "/api/v1/push/subscription">,
) => {
  const session = await requireSession(c);
  if (session.isErr()) {
    return jsonAuthError(c, session.error);
  }
  const current = await findTokenPushSubscription(c.env.DB, session.value.token.id);
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
