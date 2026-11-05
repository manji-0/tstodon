import type { Context } from "hono";
import {
  type LocalStatus,
  NotificationGroup,
  type NotificationGroupPage,
  type NotificationGroupTarget,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "../d1";
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
  queryAccountsLimit,
  queryCursor,
  queryNotificationsLimit,
  setLinkHeader,
  setPaginationLinks,
  requireUser,
} from "../http";
import { getMarkers } from "../marker-store";
import { accountDocumentsByIds } from "../account-documents";
import { availableAccountIds } from "../account-presentation";
import { mastodonNotification, mastodonNotifications } from "../notification-documents";
import { reportDocumentsByIds } from "../report-documents";
import { findAccountSeveranceEvents, severanceEventDocument } from "../severed-relationship-store";
import { statusDocumentsByIds } from "../status-documents";
import { parseInstanceIdentity } from "../runtime-config";
import {
  clearNotifications,
  countUnreadNotifications,
  dismissNotification,
  dismissNotificationGroup,
  findNotificationById,
  listNotifications,
  type NotificationFilters,
  type NotificationRow,
  groupedEntry,
  summarizeNotificationGroup,
} from "../notification-store";
import { findStatusesByIds } from "../status-store";
import { mutedThreadStatusIds } from "../status-mute-store";

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

export const getV1Notifications = async (
  c: Context<{ Bindings: Env }, "/api/v1/notifications">,
) => {
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
  // Also hides notifications created before the thread was muted.
  const mutedStatuses = await mutedThreadStatusIds(
    c.env.DB,
    identity.value,
    user.value.id,
    statusIds,
  );
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
  if (rendered.isErr()) {
    return jsonRepositoryError(c, rendered.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  for (const row of visibleRows) {
    const found = rendered.value.get(row.id);
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
  // Mastodon pages the notification list by notification id, over the rows
  // the page read: rows left out here do not end the list.
  setPaginationLinks(
    c,
    rows.value.map((row) => row.id),
    limit,
  );
  return c.json(documents);
};

export const getV1NotificationsUnreadCount = async (
  c: Context<{ Bindings: Env }, "/api/v1/notifications/unread_count">,
) => {
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
};

export const getV1NotificationsById = async (
  c: Context<{ Bindings: Env }, "/api/v1/notifications/:id">,
) => {
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
  const rendered = await mastodonNotification(c.env, identity.value, row.value, user.value.id);
  if (rendered.isErr()) {
    return jsonRepositoryError(c, rendered.error.message);
  }
  const document = rendered.value;
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
};

export const postV1NotificationsClear = async (
  c: Context<{ Bindings: Env }, "/api/v1/notifications/clear">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const cleared = await clearNotifications(c.env.DB, user.value.id);
  if (cleared.isErr()) {
    return jsonRepositoryError(c, cleared.error.message);
  }
  return c.json({});
};

export const postV1NotificationsByIdDismiss = async (
  c: Context<{ Bindings: Env }, "/api/v1/notifications/:id/dismiss">,
) => {
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
};

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
    groupedTypes: new Set(requested.length > 0 ? requested : NotificationGroup.defaultGroupedTypes),
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
 * bounded. A full window whose senders are all unavailable is not the end of
 * the list (the web app stops paging at an empty page), so reading older
 * windows goes on, up to {@link NOTIFICATION_GROUP_WINDOWS}.
 */
const groupedNotificationPage = async (
  c: Context<{ Bindings: Env }>,
  accountId: string,
): Promise<
  | Readonly<{
      kind: "Ok";
      page: NotificationGroupPage;
      /** Where the next page reads on when every window read showed nothing. */
      olderThan: string | undefined;
    }>
  | Readonly<{ kind: "Err"; message: string }>
> => {
  const { groupedTypes, filters, limit } = groupedQuery(c);
  const window = Math.min(Math.max(limit, 1) * 4, NOTIFICATION_GROUP_ROW_CAP);
  // Only a page read downwards (`max_id`, or none) has older windows to read on.
  const pagesDown = filters.minId === undefined && filters.sinceId === undefined;
  const visible: NotificationRow[] = [];
  let cursor = filters;
  // Set while the windows read so far were full and showed nothing.
  let olderThan: string | undefined;
  for (let read = 0; read < NOTIFICATION_GROUP_WINDOWS; read += 1) {
    const rows = await listNotifications(c.env.DB, accountId, window, cursor);
    if (rows.isErr()) {
      return { kind: "Err", message: rows.error.message };
    }
    // As Mastodon's `without_suspended`, notifications from senders that are not available are left out.
    const senders = await availableAccountIds(
      c.env,
      rows.value.map((row) => row.from_account_id),
    );
    if (senders.isErr()) {
      return { kind: "Err", message: senders.error.message };
    }
    visible.push(...rows.value.filter((row) => senders.value.has(row.from_account_id)));
    const last = rows.value.at(-1);
    if (visible.length > 0 || !pagesDown || !last || rows.value.length < window) {
      olderThan = undefined;
      break;
    }
    olderThan = last.id;
    cursor = { ...cursor, maxId: last.id };
  }
  // A `min_id` read comes back oldest first; the fold takes newest first.
  const pagesUp = filters.minId !== undefined;
  const entries = (pagesUp ? visible.toReversed() : visible).map(groupedEntry);
  const page = NotificationGroup.fold(entries, groupedTypes, limit, pagesUp ? "Newer" : "Older");
  return { kind: "Ok", page, olderThan };
};

/**
 * Mastodon's `by_group_key` for one account. A type and target key leaves out
 * the notifications the policy holds, which Mastodon gives no group key; an
 * `ungrouped-<id>` key names its notification held or not. The list's cursors,
 * `limit` and type filters do not apply.
 */
const groupTarget = (
  c: Context<{ Bindings: Env }>,
  groupKey: string,
): Readonly<{ group: NotificationGroupTarget; includeFiltered: boolean }> | undefined => {
  const group = NotificationGroup.target(groupKey, groupedQuery(c).groupedTypes);
  return group ? { group, includeFiltered: group.kind === "Notification" } : undefined;
};

/**
 * One group by key, as Mastodon's `show`: the count and bounds come from SQL,
 * the sample from the newest senders that are available (`without_suspended`).
 * Undefined when the key names no notification from an available sender.
 */
const notificationGroupByKey = async (
  c: Context<{ Bindings: Env }>,
  accountId: string,
  groupKey: string,
): Promise<Result<NotificationGroup | undefined, RepositoryError>> => {
  const target = groupTarget(c, groupKey);
  if (!target) {
    return ok(undefined);
  }
  const summary = await summarizeNotificationGroup(c.env.DB, accountId, target.group);
  if (summary.isErr()) {
    return err(summary.error);
  }
  if (!summary.value) {
    return ok(undefined);
  }
  const rows = await listNotifications(c.env.DB, accountId, GROUP_SENDER_WINDOW, target);
  if (rows.isErr()) {
    return err(rows.error);
  }
  const senderIds = rows.value.map((row) => row.from_account_id);
  const available = await availableAccountIds(c.env, senderIds);
  if (available.isErr()) {
    return err(available.error);
  }
  const senders = senderIds.filter((id) => available.value.has(id));
  return ok(
    senders.length === 0
      ? undefined
      : NotificationGroup.summarized(groupKey, summary.value, senders),
  );
};

const groupEnvelope = async (
  c: Context<{ Bindings: Env }>,
  accountId: string,
  groups: ReadonlyArray<NotificationGroup>,
  accountIds: ReadonlyArray<string>,
  statusIds: ReadonlyArray<string>,
  withPageIds: boolean,
): Promise<Result<Record<string, unknown>, RepositoryError>> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return ok({ accounts: [], statuses: [], notification_groups: [] });
  }
  const [resolvedAccounts, statusDocuments, resolvedReports, severance] = await Promise.all([
    accountDocumentsByIds(c.env, identity.value, accountIds),
    statusDocumentsByIds(c.env, identity.value, statusIds, accountId),
    reportDocumentsByIds(
      c.env,
      identity.value,
      groups.flatMap((group) => (group.reportId ? [group.reportId] : [])),
    ),
    findAccountSeveranceEvents(
      c.env.DB,
      groups.flatMap((group) => (group.severanceEventId ? [group.severanceEventId] : [])),
    ),
  ]);
  if (resolvedAccounts.isErr()) {
    return err(resolvedAccounts.error);
  }
  if (resolvedReports.isErr()) {
    return err(resolvedReports.error);
  }
  if (statusDocuments.isErr()) {
    return err(statusDocuments.error);
  }
  const accountDocuments = resolvedAccounts.value;
  const reportDocuments = resolvedReports.value;
  const events = new Map(
    (severance.isOk() ? severance.value : []).map((event) => [event.id, event]),
  );
  const accounts = accountIds.flatMap((id) => accountDocuments.get(id) ?? []);
  const statuses = statusIds.flatMap((id) => statusDocuments.value.get(id) ?? []);
  return ok({
    accounts,
    statuses,
    notification_groups: groups.map((group) => {
      const event = group.severanceEventId ? events.get(group.severanceEventId) : undefined;
      return {
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
        ...(group.reportId && reportDocuments.has(group.reportId)
          ? { report: reportDocuments.get(group.reportId) }
          : {}),
        ...(event ? { event: severanceEventDocument(event) } : {}),
      };
    }),
  });
};

/** Mastodon caps a grouped page at 80 groups; keep the row window bounded too. */
const NOTIFICATION_GROUP_ROW_CAP = 200;

/** How many row windows one grouped page reads past windows with nothing to show. */
const NOTIFICATION_GROUP_WINDOWS = 5;

/**
 * How many of a group's newest notifications a read by key takes its sample
 * senders from. Mastodon reads the sample in SQL; availability is decided
 * here, so the read is bounded instead.
 */
const GROUP_SENDER_WINDOW = 40;

export const getV2NotificationsUnreadCount = async (
  c: Context<{ Bindings: Env }, "/api/v2/notifications/unread_count">,
) => {
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
  const unreadKeys = new Set(
    rows.value
      .filter((row) => !(markerId && row.id <= markerId))
      .map((row) => NotificationGroup.key(groupedEntry(row), groupedTypes)),
  );
  return c.json({ count: unreadKeys.size });
};

export const getV2Notifications = async (
  c: Context<{ Bindings: Env }, "/api/v2/notifications">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const read = await groupedNotificationPage(c, user.value.id);
  if (read.kind === "Err") {
    return jsonRepositoryError(c, read.message);
  }
  const { page } = read;
  if (page.kind === "Empty") {
    // Past the window bound with nothing shown, the next page reads on from
    // the last row read instead of ending the list.
    setLinkHeader(c, { next: read.olderThan, prev: undefined });
    return c.json({ accounts: [], statuses: [], notification_groups: [] });
  }
  const envelope = await groupEnvelope(
    c,
    user.value.id,
    page.groups,
    page.accountIds,
    page.statusIds,
    true,
  );
  if (envelope.isErr()) {
    return jsonRepositoryError(c, envelope.error.message);
  }
  setLinkHeader(c, { next: page.oldestId, prev: page.newestId });
  return c.json(envelope.value);
};

export const getV2NotificationsByGroupKey = async (
  c: Context<{ Bindings: Env }, "/api/v2/notifications/:groupKey">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const group = await notificationGroupByKey(c, user.value.id, c.req.param("groupKey"));
  if (group.isErr()) {
    return jsonRepositoryError(c, group.error.message);
  }
  if (!group.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  // As Mastodon's `show`, the envelope carries the sample accounts only.
  const envelope = await groupEnvelope(
    c,
    user.value.id,
    [group.value],
    group.value.sampleAccountIds,
    group.value.statusId ? [group.value.statusId] : [],
    false,
  );
  return envelope.isErr() ? jsonRepositoryError(c, envelope.error.message) : c.json(envelope.value);
};

export const getV2NotificationsByGroupKeyAccounts = async (
  c: Context<{ Bindings: Env }, "/api/v2/notifications/:groupKey/accounts">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  // As Mastodon's `Notifications::AccountsController`: one sender per
  // notification of the group, newest first, paged by notification id.
  const limit = queryAccountsLimit(c.req.query("limit"));
  const cursor = queryCursor(c);
  const target = groupTarget(c, c.req.param("groupKey"));
  const rows = target
    ? await listNotifications(c.env.DB, user.value.id, limit, { ...target, ...cursor })
    : ok([]);
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  // A `min_id` read comes back oldest first.
  const page = cursor.minId === undefined ? rows.value : rows.value.toReversed();
  const senderIds = page.map((row) => row.from_account_id);
  const available = await availableAccountIds(c.env, senderIds);
  if (available.isErr()) {
    return jsonRepositoryError(c, available.error.message);
  }
  const shown = senderIds.filter((id) => available.value.has(id));
  const documents = await accountDocumentsByIds(c.env, identity.value, shown);
  if (documents.isErr()) {
    return jsonRepositoryError(c, documents.error.message);
  }
  setPaginationLinks(
    c,
    page.map((row) => row.id),
    limit,
  );
  return c.json(shown.flatMap((id) => documents.value.get(id) ?? []));
};

export const postV2NotificationsByGroupKeyDismiss = async (
  c: Context<{ Bindings: Env }, "/api/v2/notifications/:groupKey/dismiss">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  // As Mastodon's `by_group_key(...).destroy_all` and `render_empty`: every
  // notification the key names, whoever sent it, and 200 even when it names
  // none.
  const target = groupTarget(c, c.req.param("groupKey"));
  if (target) {
    const dismissed = await dismissNotificationGroup(c.env.DB, user.value.id, target.group);
    if (dismissed.isErr()) {
      return jsonRepositoryError(c, dismissed.error.message);
    }
  }
  return c.json({});
};
