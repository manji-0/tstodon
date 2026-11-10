import type { Context } from "hono";
import {
  type ApiAccountRelationshipSeveranceEventJSON,
  type ApiFilterResultJSON,
  type ApiNotificationGroupJSON,
  type ApiNotificationGroupsResultJSON,
  type ApiNotificationJSON,
  type ApiReportJSON,
  isNotificationType,
  isNotificationWithStatusType,
} from "@tstodon/api";
import {
  type ApiGetGroupedNotificationsParams,
  ApiGetGroupedNotificationsParamsSchema,
  ApiGetNotificationsParamsSchema,
} from "@tstodon/api";
import { assertNever } from "@tstodon/core";
import {
  type LocalStatus,
  NotificationGroup,
  type NotificationGroupPage,
  type NotificationGroupTarget,
} from "@tstodon/domain";
import { suspendedDomains } from "../admin-domain-block-store";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "../d1";
import { paramsCursor, readQueryParams } from "../request-params";
import {
  filteredAttribute,
  loadViewerFilters,
  matchFilters,
  type FilterWithStatuses,
} from "../filter-match";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
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
import { federationAllowHosts, parseInstanceIdentity } from "../runtime-config";
import type { RemoteActorSearchHosts } from "../remote-actor-store";
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
  pageNotificationGroups,
  summarizeNotificationGroups,
} from "../notification-store";
import { findStatusesByIds } from "../status-store";
import { mutedThreadStatusIds } from "../status-mute-store";

/** Filters matching this notification's status, for the status's `filtered` attribute. */
const notificationFiltered = (
  row: NotificationRow,
  filters: ReadonlyArray<FilterWithStatuses>,
  statuses: ReadonlyMap<string, LocalStatus>,
): ApiFilterResultJSON[] => {
  if (filters.length === 0 || !row.status_id) {
    return [];
  }
  const status = statuses.get(row.status_id);
  const text = status && status.kind === "LocalNote" ? status.text : "";
  const matches = matchFilters(filters, "notifications", text, row.status_id);
  return filteredAttribute(matches);
};

/**
 * The notification with `filtered` on its status, where Mastodon renders a
 * status's filter matches (the web UI reads them there, under the
 * `notifications` context).
 */
const withFiltered = (
  document: ApiNotificationJSON,
  filtered: ApiFilterResultJSON[],
): ApiNotificationJSON =>
  filtered.length > 0 && "status" in document && document.status
    ? { ...document, status: { ...document.status, filtered } }
    : document;

/** A list param without its blank entries (`types[]=` names no type). */
const nonBlank = (values: ReadonlyArray<string> | undefined): string[] =>
  (values ?? []).filter((value) => value.length > 0);

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
  const params = readQueryParams(c, ApiGetNotificationsParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const limit = queryNotificationsLimit(params.value.limit);
  const rows = await listNotifications(c.env.DB, user.value.id, limit, {
    types: nonBlank(params.value.types),
    excludeTypes: nonBlank(params.value.exclude_types),
    fromAccountId: params.value.account_id,
    // Mastodon's `include_filtered`: the policy-held notifications come back
    // in the list instead of only under `notifications/requests`.
    includeFiltered: params.value.include_filtered ?? false,
    ...paramsCursor(params.value),
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
  const documents: ApiNotificationJSON[] = [];
  for (const row of visibleRows) {
    const found = rendered.value.get(row.id);
    if (!found) {
      continue;
    }
    const filtered = notificationFiltered(
      row,
      filters.isOk() ? filters.value : [],
      notificationStatuses.isOk() ? notificationStatuses.value : new Map(),
    );
    documents.push(withFiltered(found, filtered));
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
  return c.json(withFiltered(document, filtered));
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
  // Every field casts from a query string, so this parse cannot fail.
  const empty: ApiGetGroupedNotificationsParams = {};
  const params = readQueryParams(c, ApiGetGroupedNotificationsParamsSchema).unwrapOr(empty);
  const requested = nonBlank(params.grouped_types);
  return {
    type: "notifications",
    groupedTypes: new Set(
      (requested.length > 0 ? requested : NotificationGroup.defaultGroupedTypes).filter((type) =>
        NotificationGroup.groupableTypes.has(type),
      ),
    ),
    filters: {
      types: nonBlank(params.types),
      excludeTypes: nonBlank(params.exclude_types),
      fromAccountId: params.account_id,
      includeFiltered: params.include_filtered ?? false,
      ...paramsCursor(params),
    },
    limit: queryNotificationsLimit(params.limit),
  };
};

/** The federation state that hides a remote sender. */
const hidingHosts = async (env: Env): Promise<RemoteActorSearchHosts> => {
  const [allow, suspended] = await Promise.all([
    federationAllowHosts(env),
    suspendedDomains(env.DB),
  ]);
  return { suspended, allow };
};

/**
 * One page of groups, as Mastodon's `index`: SQL picks the representatives of
 * the first `limit` groups past the cursor, from available senders only, then
 * reads those groups within the page range.
 */
const groupedNotificationPage = async (
  c: Context<{ Bindings: Env }>,
  accountId: string,
): Promise<Result<NotificationGroupPage, RepositoryError>> => {
  const { groupedTypes, filters, limit } = groupedQuery(c);
  const direction = filters.minId ? "Newer" : "Older";
  const hosts = await hidingHosts(c.env);
  const representatives = await pageNotificationGroups(
    c.env.DB,
    accountId,
    limit,
    filters,
    groupedTypes,
    hosts,
    direction,
  );
  if (representatives.isErr()) {
    return err(representatives.error);
  }
  const summaries = await summarizeNotificationGroups(
    c.env.DB,
    accountId,
    representatives.value.map((representative) => representative.groupKey),
    NotificationGroup.pageRange(representatives.value, limit, direction, filters),
    hosts,
  );
  return summaries.map((byKey) => NotificationGroup.page(representatives.value, byKey));
};

/**
 * Mastodon's `by_group_key` for one account. A type and target key leaves out
 * the notifications the policy holds, which Mastodon gives no group key; an
 * `ungrouped-<id>` key names its notification held or not. The list's cursors,
 * `limit`, type filters and `grouped_types` do not apply.
 */
const groupTarget = (
  groupKey: string,
): Readonly<{ group: NotificationGroupTarget; includeFiltered: boolean }> | undefined => {
  const group = NotificationGroup.target(groupKey);
  return group ? { group, includeFiltered: group.kind === "Notification" } : undefined;
};

/**
 * One group by key, as Mastodon's `show`: its count, bounds and sample in one
 * statement, from available senders only. Undefined when the key names no
 * notification from an available sender.
 */
const notificationGroupByKey = async (
  c: Context<{ Bindings: Env }>,
  accountId: string,
  groupKey: string,
): Promise<Result<NotificationGroup | undefined, RepositoryError>> => {
  const summaries = await summarizeNotificationGroups(
    c.env.DB,
    accountId,
    [groupKey],
    { lower: undefined, upper: undefined },
    await hidingHosts(c.env),
  );
  return summaries.map((byKey) => {
    const summary = byKey.get(groupKey);
    return summary ? NotificationGroup.summarized(groupKey, summary) : undefined;
  });
};

/**
 * One group as its type renders it (see `mastodonNotifications`); the page
 * bounds only in a paginated list, as Mastodon's. A group whose report or
 * event is gone, or of a type this server does not send, is left out.
 */
const notificationGroupDocument = (
  group: NotificationGroup,
  withPageIds: boolean,
  report: ApiReportJSON | undefined,
  event: ApiAccountRelationshipSeveranceEventJSON | undefined,
): ApiNotificationGroupJSON | undefined => {
  const type = group.type;
  if (!isNotificationType(type)) {
    return undefined;
  }
  const base = {
    group_key: group.groupKey,
    notifications_count: group.notificationsCount,
    most_recent_notification_id: group.mostRecentNotificationId,
    ...(withPageIds
      ? {
          page_min_id: group.pageMinId,
          page_max_id: group.pageMaxId,
          latest_page_notification_at: group.latestPageNotificationAt,
        }
      : {}),
    sample_account_ids: [...group.sampleAccountIds],
  };
  if (isNotificationWithStatusType(type)) {
    return { ...base, type, status_id: group.statusId };
  }
  switch (type) {
    case "follow":
    case "follow_request":
    case "admin.sign_up":
    case "move":
      return { ...base, type };
    case "admin.report":
      return report && { ...base, type, report };
    case "severed_relationships":
      return event && { ...base, type, event };
    case "moderation_warning":
    case "annual_report":
    case "added_to_collection":
    case "collection_update":
      return undefined;
    default:
      return assertNever(type);
  }
};

const groupEnvelope = async (
  c: Context<{ Bindings: Env }>,
  accountId: string,
  groups: ReadonlyArray<NotificationGroup>,
  accountIds: ReadonlyArray<string>,
  statusIds: ReadonlyArray<string>,
  withPageIds: boolean,
): Promise<Result<ApiNotificationGroupsResultJSON, RepositoryError>> => {
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
    notification_groups: groups.flatMap((group) => {
      const event = group.severanceEventId ? events.get(group.severanceEventId) : undefined;
      const document = notificationGroupDocument(
        group,
        withPageIds,
        group.reportId ? reportDocuments.get(group.reportId) : undefined,
        event && severanceEventDocument(event),
      );
      return document ? [document] : [];
    }),
  });
};

/** How many of the newest notifications the grouped unread count reads. */
const NOTIFICATION_GROUP_ROW_CAP = 200;

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
  if (read.isErr()) {
    return jsonRepositoryError(c, read.error.message);
  }
  const page = read.value;
  if (page.kind === "Empty") {
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
  const target = groupTarget(c.req.param("groupKey"));
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
  const target = groupTarget(c.req.param("groupKey"));
  if (target) {
    const dismissed = await dismissNotificationGroup(c.env.DB, user.value.id, target.group);
    if (dismissed.isErr()) {
      return jsonRepositoryError(c, dismissed.error.message);
    }
  }
  return c.json({});
};
