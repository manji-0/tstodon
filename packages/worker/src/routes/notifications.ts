import { Hono } from "hono";
import type { Context } from "hono";
import type { LocalStatus } from "@tstodon/domain";
import { isTruthy } from "../form-values";
import {
  filteredAttribute,
  loadViewerFilters,
  matchFilters,
  type FilterWithStatuses,
} from "../filter-match";
import {
  jsonAuthError,
  jsonRepositoryError,
  queryCursor,
  queryNotificationsLimit,
  setPaginationLinks,
  requireUser,
} from "../http";
import { getMarkers } from "../marker-store";
import { accountDocumentsByIds } from "../account-documents";
import { mastodonNotification, mastodonNotifications } from "../notification-documents";
import { statusDocumentsByIds } from "../status-documents";
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
  type NotificationRow,
} from "../notification-store";
import { findStatusesByIds } from "../status-store";
import { mutedThreadStatusIds } from "../status-mute-store";

export const notificationRoutes = new Hono<{ Bindings: Env }>();

/** Filters matching this notification, for the `filtered` attribute. */
const notificationFiltered = (
  row: NotificationRow,
  filters: ReadonlyArray<FilterWithStatuses>,
  statuses: ReadonlyMap<string, LocalStatus>,
): ReadonlyArray<Record<string, unknown>> => {
  if (filters.length === 0 || !row.status_id) {
    return [];
  }
  const status = statuses.get(row.status_id);
  const text = status && status.kind === "LocalNote" ? status.text : "";
  const matches = matchFilters(filters, "notifications", text, row.status_id);
  return filteredAttribute(matches);
};

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
  const limit = queryNotificationsLimit(c.req.query("limit"));
  const rows = await listNotifications(c.env.DB, user.value.id, limit, {
    types: queryValues("types"),
    excludeTypes: queryValues("exclude_types"),
    fromAccountId: c.req.query("account_id"),
    // Mastodon's `include_filtered`: the policy-held notifications come back
    // in the list instead of only under `notifications/requests`.
    includeFiltered: isTruthy(c.req.query("include_filtered")),
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
  const visibleRows = rows.value.filter(
    (row) => !(row.status_id && mutedStatuses.value.has(row.status_id)),
  );
  const rendered = await mastodonNotifications(c.env, identity.value, visibleRows, user.value.id);
  const documents: Record<string, unknown>[] = [];
  for (const row of visibleRows) {
    const found = rendered.get(row.id);
    if (!found) {
      continue;
    }
    const document = { ...found };
    const filtered = notificationFiltered(
      row,
      filters.isOk() ? filters.value : [],
      notificationStatuses.isOk() ? notificationStatuses.value : new Map(),
    );
    if (filtered.length > 0) {
      document.filtered = filtered;
    }
    documents.push(document);
  }
  // Mastodon pages the notification list by notification id.
  setPaginationLinks(
    c,
    documents.map((document) => String(document.id)),
    limit,
  );
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
  // The single notification carries the same `filtered` attribute as the list.
  const filters = await loadViewerFilters(c.env.DB, user.value.id);
  const statuses = row.value.status_id
    ? await findStatusesByIds(c.env.DB, [row.value.status_id])
    : undefined;
  const filtered = notificationFiltered(
    row.value,
    filters.isOk() ? filters.value : [],
    statuses?.isOk() ? statuses.value : new Map(),
  );
  return c.json(filtered.length > 0 ? { ...document, filtered } : document);
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
      includeFiltered: isTruthy(c.req.query("include_filtered")),
      ...queryCursor(c),
    },
    limit: queryNotificationsLimit(c.req.query("limit")),
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
  const [accountDocuments, statusDocuments] = await Promise.all([
    accountDocumentsByIds(c.env, identity.value, accountIds),
    statusDocumentsByIds(c.env, identity.value, statusIds, accountId),
  ]);
  const accounts = accountIds.flatMap((id) => accountDocuments.get(id) ?? []);
  const statuses = statusIds.flatMap((id) => statusDocuments.get(id) ?? []);
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
  const documents = await accountDocumentsByIds(c.env, identity.value, group.fromAccountIds);
  return c.json(group.fromAccountIds.flatMap((id) => documents.get(id) ?? []));
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
