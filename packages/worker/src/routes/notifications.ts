import { Hono } from "hono";
import type { Context } from "hono";
import { findAccountById } from "../account-store";
import { filteredAttribute, loadViewerFilters, matchFilters } from "../filter-match";
import { jsonAuthError, jsonRepositoryError, queryCursor, queryLimit, requireUser } from "../http";
import { getMarkers } from "../marker-store";
import {
  mastodonAccountDocument,
  mastodonFilterV2,
  mastodonNotification,
  mastodonStatuses,
} from "../mastodon";
import {
  DEFAULT_GROUPED_TYPES,
  groupNotifications,
  notificationGroupKey,
  type NotificationGroup,
} from "../notification-groups";
import { parseInstanceIdentity } from "../runtime-config";
import {
  clearNotifications,
  countUnreadNotifications,
  dismissNotification,
  findNotificationById,
  listNotifications,
  type NotificationFilters,
} from "../social-store";
import { findStatusesByIds } from "../status-store";
import { mutedThreadStatusIds } from "../status-mute-store";

export const notificationRoutes = new Hono<{ Bindings: Env }>();

notificationRoutes.get("/api/v1/notifications", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const queryValues = (key: string): string[] =>
    [...(c.req.queries(`${key}[]`) ?? []), ...(c.req.queries(key) ?? [])].filter(
      (value) => value.length > 0,
    );
  const rows = await listNotifications(c.env.DB, user.value.id, queryLimit(c.req.query("limit")), {
    types: queryValues("types"),
    excludeTypes: queryValues("exclude_types"),
    fromAccountId: c.req.query("account_id"),
    ...queryCursor(c),
  });
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  const statusIds = rows.value
    .map((row) => row.status_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const mutedStatuses = await mutedThreadStatusIds(c.env.DB, user.value.id, statusIds);
  if (mutedStatuses.isErr()) {
    return jsonRepositoryError(c, mutedStatuses.error.message);
  }
  // Notifications carry the same `filtered` attribute the search results do.
  const filters = await loadViewerFilters(c.env.DB, user.value.id);
  const notificationStatuses = await findStatusesByIds(c.env.DB, statusIds);
  const documents: Record<string, unknown>[] = [];
  for (const row of rows.value) {
    if (row.status_id && mutedStatuses.value.has(row.status_id)) {
      continue;
    }
    const document = await mastodonNotification(c.env, identity.value, row, user.value.id);
    if (!document) {
      continue;
    }
    if (filters.isOk() && filters.value.length > 0 && row.status_id) {
      const status = notificationStatuses.isOk()
        ? notificationStatuses.value.get(row.status_id)
        : undefined;
      const text = status && status.kind === "LocalNote" ? status.text : "";
      const matches = matchFilters(filters.value, "notifications", text, row.status_id);
      if (matches.length > 0) {
        document.filtered = filteredAttribute(matches, (filterRow) => mastodonFilterV2(filterRow));
      }
    }
    documents.push(document);
  }
  return c.json(documents);
});

notificationRoutes.get("/api/v1/notifications/unread_count", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const markers = await getMarkers(c.env.DB, user.value.id, ["notifications"]);
  if (markers.isErr()) {
    return jsonRepositoryError(c, markers.error.message);
  }
  const markerId = markers.value.notifications?.last_read_id;
  const count = await countUnreadNotifications(c.env.DB, user.value.id, markerId);
  if (count.isErr()) {
    return jsonRepositoryError(c, count.error.message);
  }
  return c.json({ count: count.value });
});

notificationRoutes.get("/api/v1/notifications/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const row = await findNotificationById(c.env.DB, user.value.id, c.req.param("id") ?? "");
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const document = await mastodonNotification(c.env, identity.value, row.value, user.value.id);
  if (!document) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(document);
});

notificationRoutes.post("/api/v1/notifications/clear", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const cleared = await clearNotifications(c.env.DB, user.value.id);
  if (cleared.isErr()) {
    return jsonRepositoryError(c, cleared.error.message);
  }
  return c.json({});
});

notificationRoutes.post("/api/v1/notifications/:id/dismiss", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const dismissed = await dismissNotification(c.env.DB, user.value.id, c.req.param("id") ?? "");
  if (dismissed.isErr()) {
    return jsonRepositoryError(c, dismissed.error.message);
  }
  if (!dismissed.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
});

/** Shared query handling for the grouped (`v2`) endpoints. */
const groupedQuery = (
  c: Context<{ Bindings: Env }>,
): {
  type: string;
  groupedTypes: ReadonlySet<string>;
  filters: NotificationFilters;
  limit: number;
} => {
  const queryValues = (key: string): string[] =>
    [...(c.req.queries(`${key}[]`) ?? []), ...(c.req.queries(key) ?? [])].filter(
      (value) => value.length > 0,
    );
  const requested = queryValues("grouped_types");
  return {
    type: "notifications",
    groupedTypes: new Set(requested.length > 0 ? requested : DEFAULT_GROUPED_TYPES),
    filters: {
      types: queryValues("types"),
      excludeTypes: queryValues("exclude_types"),
      fromAccountId: c.req.query("account_id"),
      ...queryCursor(c),
    },
    limit: queryLimit(c.req.query("limit"), 40),
  };
};

/**
 * `limit` counts groups, so fetch a wider page of notifications and fold it.
 * Mastodon caps a page at 80 groups; the row window is capped to keep D1 work
 * bounded.
 */
const groupedNotificationPage = async (
  c: Context<{ Bindings: Env }>,
  accountId: string,
): Promise<
  | Readonly<{
      kind: "Ok";
      groups: ReadonlyArray<NotificationGroup>;
      accountIds: ReadonlyArray<string>;
      statusIds: ReadonlyArray<string>;
    }>
  | Readonly<{ kind: "Err"; message: string }>
> => {
  const { groupedTypes, filters, limit } = groupedQuery(c);
  const rows = await listNotifications(
    c.env.DB,
    accountId,
    Math.min(Math.max(limit, 1) * 4, NOTIFICATION_GROUP_ROW_CAP),
    filters,
  );
  if (rows.isErr()) {
    return { kind: "Err", message: rows.error.message };
  }
  const grouped = groupNotifications(rows.value, groupedTypes, limit);
  return {
    kind: "Ok",
    groups: grouped.groups,
    accountIds: grouped.accountIds,
    statusIds: grouped.statusIds,
  };
};

const groupEnvelope = async (
  c: Context<{ Bindings: Env }>,
  accountId: string,
  groups: ReadonlyArray<NotificationGroup>,
  accountIds: ReadonlyArray<string>,
  statusIds: ReadonlyArray<string>,
  withPageIds: boolean,
): Promise<Record<string, unknown>> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return { accounts: [], statuses: [], notification_groups: [] };
  }
  const accounts =
    accountIds.length > 0
      ? (
          await Promise.all(
            accountIds.map(async (id) => {
              const account = await findAccountById(c.env.DB, id);
              return account.isOk() && account.value
                ? await mastodonAccountDocument(c.env, identity.value, account.value)
                : undefined;
            }),
          )
        ).flatMap((document) => (document ? [document] : []))
      : [];
  let statuses: Record<string, unknown>[] = [];
  if (statusIds.length > 0) {
    const found = await findStatusesByIds(c.env.DB, statusIds);
    if (found.isOk()) {
      statuses = await mastodonStatuses(
        c.env,
        identity.value,
        [...found.value.values()],
        accountId,
      );
    }
  }
  return {
    accounts,
    statuses,
    notification_groups: groups.map((group) => ({
      group_key: group.groupKey,
      notifications_count: group.notificationsCount,
      type: group.type,
      most_recent_notification_id: group.mostRecentNotificationId,
      ...(withPageIds
        ? {
            page_min_id: group.pageMinId,
            page_max_id: group.pageMaxId,
            latest_page_notification_at: group.latestPageNotificationAt,
          }
        : {}),
      sample_account_ids: group.sampleAccountIds,
      ...(group.statusId ? { status_id: group.statusId } : {}),
    })),
  };
};

/** Mastodon caps a grouped page at 80 groups; keep the row window bounded too. */
const NOTIFICATION_GROUP_ROW_CAP = 200;

notificationRoutes.get("/api/v2/notifications/unread_count", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const markers = await getMarkers(c.env.DB, user.value.id, ["notifications"]);
  if (markers.isErr()) {
    return jsonRepositoryError(c, markers.error.message);
  }
  const markerId = markers.value.notifications?.last_read_id;
  const { groupedTypes } = groupedQuery(c);
  const rows = await listNotifications(c.env.DB, user.value.id, NOTIFICATION_GROUP_ROW_CAP, {
    maxId: undefined,
  });
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  const unreadKeys = new Set<string>();
  for (const row of rows.value) {
    if (markerId && row.id <= markerId) {
      continue;
    }
    unreadKeys.add(notificationGroupKey(row, groupedTypes));
  }
  return c.json({ count: unreadKeys.size });
});

notificationRoutes.get("/api/v2/notifications", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const page = await groupedNotificationPage(c, user.value.id);
  if (page.kind === "Err") {
    return jsonRepositoryError(c, page.message);
  }
  return c.json(
    await groupEnvelope(c, user.value.id, page.groups, page.accountIds, page.statusIds, true),
  );
});

notificationRoutes.get("/api/v2/notifications/:groupKey", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const groupKey = c.req.param("groupKey");
  const page = await groupedNotificationPage(c, user.value.id);
  if (page.kind === "Err") {
    return jsonRepositoryError(c, page.message);
  }
  const group = page.groups.find((candidate) => candidate.groupKey === groupKey);
  if (!group) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(
    await groupEnvelope(c, user.value.id, [group], page.accountIds, page.statusIds, false),
  );
});

notificationRoutes.get("/api/v2/notifications/:groupKey/accounts", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const page = await groupedNotificationPage(c, user.value.id);
  if (page.kind === "Err") {
    return jsonRepositoryError(c, page.message);
  }
  const group = page.groups.find((candidate) => candidate.groupKey === c.req.param("groupKey"));
  if (!group) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const accounts: Record<string, unknown>[] = [];
  for (const id of group.fromAccountIds) {
    const account = await findAccountById(c.env.DB, id);
    if (account.isOk() && account.value) {
      accounts.push(await mastodonAccountDocument(c.env, identity.value, account.value));
    }
  }
  return c.json(accounts);
});

notificationRoutes.post("/api/v2/notifications/:groupKey/dismiss", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const groupKey = c.req.param("groupKey");
  const page = await groupedNotificationPage(c, user.value.id);
  if (page.kind === "Err") {
    return jsonRepositoryError(c, page.message);
  }
  const group = page.groups.find((candidate) => candidate.groupKey === groupKey);
  if (!group) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  for (const id of group.notificationIds) {
    const dismissed = await dismissNotification(c.env.DB, user.value.id, id);
    if (dismissed.isErr()) {
      return jsonRepositoryError(c, dismissed.error.message);
    }
  }
  return c.json({});
});
