import type { ApiNotificationRequestJSON, NotificationPolicyJSON } from "@tstodon/api";
import { type Context } from "hono";
import { warmSchemas } from "@tstodon/core";
import {
  type InstanceIdentity,
  type NotificationPolicy,
  NotificationPolicyAction,
} from "@tstodon/domain";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryCursor,
  queryNotificationsLimit,
  readBody,
  requireUser,
} from "../http";
import { err, ok, type Result } from "neverthrow";
import { accountDocumentsByIds, availableAccountDocumentsByIds } from "../account-documents";
import type { RepositoryError } from "../d1";
import { statusDocumentsByIds } from "../status-documents";
import {
  acceptNotificationRequests,
  countNotificationRequests,
  dismissNotificationRequests,
  findNotificationPolicy,
  findNotificationRequest,
  listNotificationRequests,
  type NotificationRequest,
  saveNotificationPolicy,
} from "../notification-policy-store";
import { parseInstanceIdentity } from "../runtime-config";
import { isTruthy, stringList } from "../form-values";
import { dismissNotification } from "../notification-store";
import { publishToAccount } from "../stream-publish";
import { z } from "zod";
import { booleanish } from "../form-values";

export const NotificationPolicyBodySchema = z.object({
  for_not_following: z.string().optional(),
  for_not_followers: z.string().optional(),
  for_new_accounts: z.string().optional(),
  for_private_mentions: z.string().optional(),
  for_limited_accounts: z.string().optional(),
  for_bots: z.string().optional(),
  filter_not_following: booleanish,
  filter_not_followers: booleanish,
  filter_new_accounts: booleanish,
  filter_private_mentions: booleanish,
  filter_limited_accounts: booleanish,
});

export const NotificationRequestIdsBodySchema = z.object({
  id: z.union([z.array(z.string()), z.string()]).optional(),
  "id[]": z.union([z.array(z.string()), z.string()]).optional(),
});

/**
 * Notification policy and requests. Mounted ahead of `notificationRoutes` so
 * `/policy`, `/requests`, and `/requests/merged` win over the `:id` and
 * `:groupKey` routes registered there.
 */

/**
 * Request documents for a page, with one account batch and one status batch.
 * `senders` renders the senders; a request whose sender it leaves out is left
 * out too.
 */
const requestDocuments = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  accountId: string,
  requests: ReadonlyArray<NotificationRequest>,
  senders: typeof accountDocumentsByIds,
): Promise<Result<ApiNotificationRequestJSON[], RepositoryError>> => {
  // The status stored with the held notification is the exact one.
  const [resolved, statuses] = await Promise.all([
    senders(
      c.env,
      identity,
      requests.map((request) => request.fromAccountId),
    ),
    statusDocumentsByIds(
      c.env,
      identity,
      requests.flatMap((request) => (request.statusId ? [request.statusId] : [])),
      accountId,
    ),
  ]);
  if (resolved.isErr()) {
    return err(resolved.error);
  }
  if (statuses.isErr()) {
    return err(statuses.error);
  }
  const accounts = resolved.value;
  return ok(
    requests.flatMap((request) => {
      const account = accounts.get(request.fromAccountId);
      return account
        ? [
            {
              id: request.id,
              created_at: request.createdAt,
              updated_at: request.updatedAt,
              notifications_count: String(request.notificationsCount),
              account,
              last_status: request.statusId ? (statuses.value.get(request.statusId) ?? null) : null,
            },
          ]
        : [];
    }),
  );
};

const policyDocument = async (
  env: Env,
  accountId: string,
  policy: NotificationPolicy,
): Promise<NotificationPolicyJSON> => {
  const counts = await countNotificationRequests(env.DB, accountId);
  return {
    for_not_following: policy.forNotFollowing,
    for_not_followers: policy.forNotFollowers,
    for_new_accounts: policy.forNewAccounts,
    for_private_mentions: policy.forPrivateMentions,
    for_limited_accounts: policy.forLimitedAccounts,
    for_bots: policy.forBots,
    summary: {
      pending_requests_count: counts.isOk() ? counts.value.requests : 0,
      pending_notifications_count: counts.isOk() ? counts.value.notifications : 0,
    },
  };
};

export const getV2NotificationsPolicy = async (
  c: Context<{ Bindings: Env }, "/api/v2/notifications/policy">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const policy = await findNotificationPolicy(c.env.DB, user.value.id);
  if (policy.isErr()) {
    return jsonRepositoryError(c, policy.error.message);
  }
  return c.json(await policyDocument(c.env, user.value.id, policy.value));
};

export const patchV2NotificationsPolicy = async (
  c: Context<{ Bindings: Env }, "/api/v2/notifications/policy">,
) => {
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
      const parsed = NotificationPolicyAction.parse(raw.trim().toLowerCase());
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
    // Mastodon 4.6 added `for_bots` without a legacy `filter_bots` boolean.
    forBots: action(body.value.for_bots, undefined, existing.value.forBots),
  };
  const saved = await saveNotificationPolicy(c.env.DB, user.value.id, policy);
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  return c.json(await policyDocument(c.env, user.value.id, policy));
};

export const getV1NotificationsRequests = async (
  c: Context<{ Bindings: Env }, "/api/v1/notifications/requests">,
) => {
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
    queryNotificationsLimit(c.req.query("limit")),
    queryCursor(c),
  );
  if (requests.isErr()) {
    return jsonRepositoryError(c, requests.error.message);
  }
  // As Mastodon, the list leaves out requests from accounts that are not available.
  const documents = await requestDocuments(
    c,
    identity.value,
    user.value.id,
    requests.value,
    availableAccountDocumentsByIds,
  );
  return documents.isErr()
    ? jsonRepositoryError(c, documents.error.message)
    : c.json(documents.value);
};

export const getV1NotificationsRequestsMerged = (
  c: Context<{ Bindings: Env }, "/api/v1/notifications/requests/merged">,
) => c.json({ merged: false });

export const getV1NotificationsRequestsById = async (
  c: Context<{ Bindings: Env }, "/api/v1/notifications/requests/:id">,
) => {
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
  const documents = await requestDocuments(
    c,
    identity.value,
    user.value.id,
    [request.value],
    accountDocumentsByIds,
  );
  if (documents.isErr()) {
    return jsonRepositoryError(c, documents.error.message);
  }
  const [document] = documents.value;
  return document ? c.json(document) : c.json({ error: "Record not found", kind: "NotFound" }, 404);
};

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

export const postV1NotificationsRequestsByIdAccept = (
  c: Context<{ Bindings: Env }, "/api/v1/notifications/requests/:id/accept">,
) => acceptOrDismiss(c, true);
export const postV1NotificationsRequestsByIdDismiss = (
  c: Context<{ Bindings: Env }, "/api/v1/notifications/requests/:id/dismiss">,
) => acceptOrDismiss(c, false);

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

export const postV1NotificationsRequestsAccept = (
  c: Context<{ Bindings: Env }, "/api/v1/notifications/requests/accept">,
) => bulkRequests(c, true);
export const postV1NotificationsRequestsDismiss = (
  c: Context<{ Bindings: Env }, "/api/v1/notifications/requests/dismiss">,
) => bulkRequests(c, false);

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([NotificationPolicyBodySchema, NotificationRequestIdsBodySchema]);
