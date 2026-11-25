import { requestViewerId } from "../auth";
import type { Context } from "hono";
import {
  type ApiAccountRelationshipSeveranceEventJSON,
  type ApiCollectionJSON,
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
import { type LocalStatus, NotificationGroup, type NotificationGroupPage } from "@tstodon/domain";
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
  queryLimit,
  queryCursor,
  setLinkHeader,
  setPaginationLinks,
  setTimelineLinks,
  requireUser,
  PageSize,
} from "../http";
import { getMarkers } from "../marker-store";
import { accountDocumentsByIds } from "../account-documents";
import { availableAccountIds } from "../account-presentation";
import { mastodonNotification, mastodonNotifications } from "../notification-documents";
import { notificationCollections } from "../collection-documents";
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
  const limit = queryLimit(c, PageSize.accounts);
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
  // the page read, and offers the next page after any page that is not empty.
  setTimelineLinks(
    c,
    rows.value.map((row) => row.id),
    ["account_id", "types", "exclude_types", "include_filtered", "supported_types"],
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
  const count = await countUnreadNotifications(
    c.env.DB,
    user.value.id,
    markerId,
    queryLimit(c, PageSize.unreadNotifications),
  );
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
    groupedTypes:
      requested.length > 0
        ? new Set(requested.filter((type) => NotificationGroup.groupableTypes.has(type)))
        : NotificationGroup.groupableTypes,
    filters: {
      types: nonBlank(params.types),
      excludeTypes: nonBlank(params.exclude_types),
      fromAccountId: params.account_id,
      includeFiltered: params.include_filtered ?? false,
      ...paramsCursor(params),
    },
    limit: queryLimit(c, PageSize.accounts),
  };
};

/** The federation state that hides a remote sender. */
const hidingHosts = async (env: Env): Promise<RemoteActorSearchHosts> => ({
  allow: await federationAllowHosts(env),
});

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
  collection: ApiCollectionJSON | null,
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
    case "added_to_collection":
    case "collection_update":
      return { ...base, type, collection };
    case "moderation_warning":
    case "annual_report":
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
  const [resolvedAccounts, statusDocuments, resolvedReports, severance, collections] =
    await Promise.all([
      accountDocumentsByIds(c.env, identity.value, accountId, accountIds),
      statusDocumentsByIds(c.env, identity.value, statusIds, accountId),
      reportDocumentsByIds(
        c.env,
        identity.value,
        accountId,
        groups.flatMap((group) => (group.reportId ? [group.reportId] : [])),
      ),
      findAccountSeveranceEvents(
        c.env.DB,
        groups.flatMap((group) => (group.severanceEventId ? [group.severanceEventId] : [])),
      ),
      notificationCollections(c.env, identity.value, accountId, groups),
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
  if (collections.isErr()) {
    return err(collections.error);
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
        collections.value(group),
      );
      return document ? [document] : [];
    }),
  });
};

/**
 * As Mastodon's `unread_count`: the groups of the first `limit` past the read
 * marker (`paginate_groups_by_min_id(limit, min_id: last_read_id)`), under
 * the list's `types`, `exclude_types`, `include_filtered` and `grouped_types`.
 */
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
  const { groupedTypes, filters } = groupedQuery(c);
  const groups = await pageNotificationGroups(
    c.env.DB,
    user.value.id,
    queryLimit(c, PageSize.unreadNotifications),
    {
      ...filters,
      fromAccountId: undefined,
      maxId: undefined,
      sinceId: undefined,
      minId: markers.value.notifications?.last_read_id,
    },
    groupedTypes,
    await hidingHosts(c.env),
    "Newer",
  );
  if (groups.isErr()) {
    return jsonRepositoryError(c, groups.error.message);
  }
  return c.json({ count: groups.value.length });
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
  setLinkHeader(c, { next: page.oldestId, prev: page.newestId }, [
    "include_filtered",
    "types",
    "exclude_types",
    "grouped_types",
    "supported_types",
  ]);
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
  // notification that stored the key, newest first, paged by notification
  // id. No notification stores an `ungrouped-<id>` key.
  const limit = queryLimit(c, PageSize.accounts);
  const cursor = queryCursor(c);
  const target = NotificationGroup.target(c.req.param("groupKey"));
  const rows =
    target.kind === "Group"
      ? await listNotifications(c.env.DB, user.value.id, limit, {
          groupKey: target.key,
          ...cursor,
        })
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
  const documents = await accountDocumentsByIds(
    c.env,
    identity.value,
    await requestViewerId(c.req.raw, c.env),
    shown,
  );
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
  const dismissed = await dismissNotificationGroup(
    c.env.DB,
    user.value.id,
    NotificationGroup.target(c.req.param("groupKey")),
  );
  if (dismissed.isErr()) {
    return jsonRepositoryError(c, dismissed.error.message);
  }
  return c.json({});
};
