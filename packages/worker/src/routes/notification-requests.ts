import { Hono } from "hono";
import type { Context } from "hono";
import { schemaResult } from "@tstodon/core";
import type { InstanceIdentity } from "@tstodon/domain";
import { findAccountById } from "../account-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAccountsLimit,
  readBody,
  requireUser,
} from "../http";
import { mastodonAccountDocument, mastodonStatus } from "../mastodon";
import {
  NotificationPolicyActionSchema,
  acceptNotificationRequests,
  countNotificationRequests,
  dismissNotificationRequests,
  findNotificationPolicy,
  findNotificationRequest,
  listNotificationRequests,
  saveNotificationPolicy,
  type NotificationPolicy,
  type NotificationPolicyAction,
  type NotificationRequest,
} from "../notification-policy-store";
import { parseInstanceIdentity } from "../runtime-config";
import {
  isTruthy,
  NotificationPolicyBodySchema,
  NotificationRequestIdsBodySchema,
  stringList,
} from "../schemas";
import { dismissNotification } from "../social-store";
import { publishToAccount } from "../stream-publish";
import { findStatusById } from "../status-store";

/**
 * Notification policy and requests. Mounted ahead of `notificationRoutes` so
 * `/policy`, `/requests`, and `/requests/merged` win over the `:id` and
 * `:groupKey` routes registered there.
 */
export const notificationRequestRoutes = new Hono<{ Bindings: Env }>();

/** Mastodon's NotificationRequest document for one held-back sender. */
const requestDocument = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  accountId: string,
  request: NotificationRequest,
): Promise<Record<string, unknown>> => {
  const account = await findAccountById(c.env.DB, request.fromAccountId);
  const accountDocument =
    account.isOk() && account.value
      ? await mastodonAccountDocument(c.env, identity, account.value)
      : null;
  // The status stored with the held notification is the exact one.
  let lastStatus: Record<string, unknown> | null = null;
  if (request.statusId) {
    const status = await findStatusById(c.env.DB, request.statusId);
    if (status.isOk() && status.value) {
      lastStatus = (await mastodonStatus(c.env, identity, status.value, accountId)) ?? null;
    }
  }
  return {
    id: request.fromAccountId,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
    notifications_count: String(request.notificationsCount),
    account: accountDocument,
    last_status: lastStatus,
  };
};

const policyDocument = async (
  env: Env,
  accountId: string,
  policy: NotificationPolicy,
): Promise<Record<string, unknown>> => {
  const counts = await countNotificationRequests(env.DB, accountId);
  return {
    for_not_following: policy.forNotFollowing,
    for_not_followers: policy.forNotFollowers,
    for_new_accounts: policy.forNewAccounts,
    for_private_mentions: policy.forPrivateMentions,
    for_limited_accounts: policy.forLimitedAccounts,
    summary: {
      pending_requests_count: counts.isOk() ? counts.value.requests : 0,
      pending_notifications_count: counts.isOk() ? counts.value.notifications : 0,
    },
  };
};

notificationRequestRoutes.get("/api/v2/notifications/policy", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const policy = await findNotificationPolicy(c.env.DB, user.value.id);
  if (policy.isErr()) {
    return jsonRepositoryError(c, policy.error.message);
  }
  return c.json(await policyDocument(c.env, user.value.id, policy.value));
});

notificationRequestRoutes.patch("/api/v2/notifications/policy", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const existing = await findNotificationPolicy(c.env.DB, user.value.id);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  const body = await readBody(c, NotificationPolicyBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  // Mastodon accepts either an action or a legacy `filter_*` boolean.
  const action = (
    raw: string | undefined,
    legacy: boolean | string | number | undefined,
    fallback: NotificationPolicyAction,
  ): NotificationPolicyAction => {
    if (raw !== undefined) {
      const parsed = schemaResult(NotificationPolicyActionSchema)(raw.trim().toLowerCase());
      return parsed.isOk() ? parsed.value : fallback;
    }
    if (legacy !== undefined) {
      return isTruthy(legacy) ? "filter" : "accept";
    }
    return fallback;
  };
  const policy: NotificationPolicy = {
    forNotFollowing: action(
      body.value.for_not_following,
      body.value.filter_not_following,
      existing.value.forNotFollowing,
    ),
    forNotFollowers: action(
      body.value.for_not_followers,
      body.value.filter_not_followers,
      existing.value.forNotFollowers,
    ),
    forNewAccounts: action(
      body.value.for_new_accounts,
      body.value.filter_new_accounts,
      existing.value.forNewAccounts,
    ),
    forPrivateMentions: action(
      body.value.for_private_mentions,
      body.value.filter_private_mentions,
      existing.value.forPrivateMentions,
    ),
    forLimitedAccounts: action(
      body.value.for_limited_accounts,
      body.value.filter_limited_accounts,
      existing.value.forLimitedAccounts,
    ),
  };
  const saved = await saveNotificationPolicy(c.env.DB, user.value.id, policy);
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  return c.json(await policyDocument(c.env, user.value.id, policy));
});

notificationRequestRoutes.get("/api/v1/notifications/requests", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  // Mastodon: `limit` defaults to 40 and caps at 80.
  const requests = await listNotificationRequests(
    c.env.DB,
    user.value.id,
    queryAccountsLimit(c.req.query("limit")),
  );
  if (requests.isErr()) {
    return jsonRepositoryError(c, requests.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  for (const request of requests.value) {
    documents.push(await requestDocument(c, identity.value, user.value.id, request));
  }
  return c.json(documents);
});

notificationRequestRoutes.get("/api/v1/notifications/requests/merged", (c) =>
  c.json({ merged: false }),
);

notificationRequestRoutes.get("/api/v1/notifications/requests/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const request = await findNotificationRequest(c.env.DB, user.value.id, c.req.param("id") ?? "");
  if (request.isErr()) {
    return jsonRepositoryError(c, request.error.message);
  }
  if (!request.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await requestDocument(c, identity.value, user.value.id, request.value));
});

const resolveRequest = async (
  c: Context<{ Bindings: Env }>,
): Promise<Response | NotificationRequest> => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const request = await findNotificationRequest(c.env.DB, user.value.id, c.req.param("id") ?? "");
  if (request.isErr()) {
    return jsonRepositoryError(c, request.error.message);
  }
  if (!request.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return request.value;
};

const acceptOrDismiss = async (c: Context<{ Bindings: Env }>, accept: boolean) => {
  const resolved = await resolveRequest(c);
  if (resolved instanceof Response) {
    return resolved;
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  if (accept) {
    const released = await acceptNotificationRequests(
      c.env.DB,
      user.value.id,
      resolved.fromAccountId,
    );
    if (released.isErr()) {
      return jsonRepositoryError(c, released.error.message);
    }
    // Clients refresh the notification list when the merge lands.
    await publishToAccount(c.env, user.value.id, { kind: "notifications_merged" });
    return c.json({});
  }
  const dismissed = await dismissNotificationRequests(
    c.env.DB,
    user.value.id,
    resolved.fromAccountId,
  );
  if (dismissed.isErr()) {
    return jsonRepositoryError(c, dismissed.error.message);
  }
  for (const notificationId of dismissed.value) {
    const gone = await dismissNotification(c.env.DB, user.value.id, notificationId);
    if (gone.isErr()) {
      return jsonRepositoryError(c, gone.error.message);
    }
  }
  return c.json({});
};

notificationRequestRoutes.post("/api/v1/notifications/requests/:id/accept", (c) =>
  acceptOrDismiss(c, true),
);
notificationRequestRoutes.post("/api/v1/notifications/requests/:id/dismiss", (c) =>
  acceptOrDismiss(c, false),
);

const bulkRequests = async (c: Context<{ Bindings: Env }>, accept: boolean): Promise<Response> => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readBody(c, NotificationRequestIdsBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const ids = [...stringList(body.value.id), ...stringList(body.value["id[]"])];
  let acceptedAny = false;
  for (const id of [...new Set(ids)]) {
    const request = await findNotificationRequest(c.env.DB, user.value.id, id);
    if (request.isErr()) {
      return jsonRepositoryError(c, request.error.message);
    }
    if (!request.value) {
      continue;
    }
    if (accept) {
      const released = await acceptNotificationRequests(
        c.env.DB,
        user.value.id,
        request.value.fromAccountId,
      );
      if (released.isErr()) {
        return jsonRepositoryError(c, released.error.message);
      }
      acceptedAny = true;
      continue;
    }
    const dismissed = await dismissNotificationRequests(
      c.env.DB,
      user.value.id,
      request.value.fromAccountId,
    );
    if (dismissed.isErr()) {
      return jsonRepositoryError(c, dismissed.error.message);
    }
    for (const notificationId of dismissed.value) {
      await dismissNotification(c.env.DB, user.value.id, notificationId);
    }
  }
  if (acceptedAny) {
    await publishToAccount(c.env, user.value.id, { kind: "notifications_merged" });
  }
  return c.json({});
};

notificationRequestRoutes.post("/api/v1/notifications/requests/accept", (c) =>
  bulkRequests(c, true),
);
notificationRequestRoutes.post("/api/v1/notifications/requests/dismiss", (c) =>
  bulkRequests(c, false),
);
