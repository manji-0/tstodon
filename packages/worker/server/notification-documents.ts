import {
  type ApiAccountJSON,
  type ApiAccountRelationshipSeveranceEventJSON,
  type ApiNotificationJSON,
  type ApiReportJSON,
  type ApiStatusJSON,
  isNotificationType,
  isNotificationWithStatusType,
  type NotificationType,
} from "@tstodon/api";
import { assertNever } from "@tstodon/core";
import { AccountPresentation, type InstanceIdentity, NotificationGroup } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { presentedAccountsByIds } from "./account-documents";
import type { RepositoryError } from "./d1";
import { reportDocumentsByIds } from "./report-documents";
import { findAccountSeveranceEvents, severanceEventDocument } from "./severed-relationship-store";
import { groupedEntry, type NotificationRow } from "./notification-store";
import { statusDocumentsByIds } from "./status-documents";

/**
 * Mastodon Notification documents keyed by notification id. A notification
 * whose sender no longer resolves or is not available is left out; a status
 * that no longer resolves renders as `status: null`. A storage error while
 * resolving the accounts or reports fails the whole page.
 */
export const mastodonNotifications = async (
  env: Env,
  identity: InstanceIdentity,
  rows: ReadonlyArray<NotificationRow>,
  viewerId: string,
): Promise<Result<ReadonlyMap<string, ApiNotificationJSON>, RepositoryError>> => {
  const [presented, statuses, reported, severance] = await Promise.all([
    presentedAccountsByIds(
      env,
      identity,
      rows.flatMap((row) =>
        row.target_account_id
          ? [row.from_account_id, row.target_account_id]
          : [row.from_account_id],
      ),
    ),
    statusDocumentsByIds(
      env,
      identity,
      rows.flatMap((row) => (row.status_id ? [row.status_id] : [])),
      viewerId,
    ),
    reportDocumentsByIds(
      env,
      identity,
      rows.flatMap((row) => (row.report_id ? [row.report_id] : [])),
    ),
    findAccountSeveranceEvents(
      env.DB,
      rows.flatMap((row) => (row.severance_event_id ? [row.severance_event_id] : [])),
    ),
  ]);
  if (presented.isErr()) {
    return err(presented.error);
  }
  if (reported.isErr()) {
    return err(reported.error);
  }
  if (statuses.isErr()) {
    return err(statuses.error);
  }
  const accounts = presented.value;
  const reports = reported.value;
  const events = new Map(
    (severance.isOk() ? severance.value : []).map((event) => [event.id, event]),
  );
  const documents = new Map<string, ApiNotificationJSON>();
  const groupedTypes = new Set(NotificationGroup.defaultGroupedTypes);
  for (const row of rows) {
    const sender = accounts.get(row.from_account_id);
    // As Mastodon's `without_suspended`, a sender that is not available hides the notification.
    if (!sender || !AccountPresentation.available(sender.presentation)) {
      continue;
    }
    const type = row.kind;
    if (!isNotificationType(type)) {
      continue;
    }
    const base = {
      id: row.id,
      created_at: row.created_at,
      // The group the web UI files it under, as Mastodon 4.3's default grouping.
      group_key: NotificationGroup.key(groupedEntry(row), groupedTypes),
      account: sender.document,
    };
    const target = row.target_account_id
      ? accounts.get(row.target_account_id)?.document
      : undefined;
    const report = row.report_id ? reports.get(row.report_id) : undefined;
    const event = row.severance_event_id ? events.get(row.severance_event_id) : undefined;
    const document = notificationDocument(type, base, {
      status: row.status_id ? (statuses.value.get(row.status_id) ?? null) : null,
      target,
      report,
      event: event && severanceEventDocument(event),
    });
    if (document) {
      documents.set(row.id, document);
    }
  }
  return ok(documents);
};

type NotificationBase = Pick<ApiNotificationJSON, "id" | "created_at" | "group_key" | "account">;

/**
 * One notification as its type renders it, or `undefined` when what the type
 * shows is gone: a `move` without its new account, an `admin.report` without
 * its report, a `severed_relationships` without its event. A type this
 * server does not send is left out.
 */
const notificationDocument = (
  type: NotificationType,
  base: NotificationBase,
  payload: Readonly<{
    status: ApiStatusJSON | null;
    target: ApiAccountJSON | undefined;
    report: ApiReportJSON | undefined;
    event: ApiAccountRelationshipSeveranceEventJSON | undefined;
  }>,
): ApiNotificationJSON | undefined => {
  if (isNotificationWithStatusType(type)) {
    return { ...base, type, status: payload.status };
  }
  switch (type) {
    case "follow":
    case "follow_request":
    case "admin.sign_up":
      return { ...base, type };
    case "admin.report":
      return payload.report && { ...base, type, report: payload.report };
    case "severed_relationships":
      return payload.event && { ...base, type, event: payload.event };
    case "move":
      return payload.target && { ...base, type, target: payload.target };
    case "moderation_warning":
    case "annual_report":
    case "added_to_collection":
    case "collection_update":
      return undefined;
    default:
      return assertNever(type);
  }
};

export const mastodonNotification = async (
  env: Env,
  identity: InstanceIdentity,
  row: NotificationRow,
  viewerId: string,
): Promise<Result<ApiNotificationJSON | undefined, RepositoryError>> =>
  (await mastodonNotifications(env, identity, [row], viewerId)).map((documents) =>
    documents.get(row.id),
  );
