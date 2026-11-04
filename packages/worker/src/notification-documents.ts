import type { InstanceIdentity } from "@tstodon/domain";
import { accountDocumentsByIds } from "./account-documents";
import { reportDocumentsByIds } from "./report-documents";
import { findAccountSeveranceEvents, severanceEventDocument } from "./severed-relationship-store";
import type { NotificationRow } from "./notification-store";
import { statusDocumentsByIds } from "./status-documents";

/**
 * Mastodon Notification documents keyed by notification id. A notification
 * whose sender no longer resolves is left out; a status that no longer
 * resolves renders as `status: null`.
 */
export const mastodonNotifications = async (
  env: Env,
  identity: InstanceIdentity,
  rows: ReadonlyArray<NotificationRow>,
  viewerId: string,
): Promise<ReadonlyMap<string, Record<string, unknown>>> => {
  const [accounts, statuses, reports, severance] = await Promise.all([
    accountDocumentsByIds(
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
  const events = new Map(
    (severance.isOk() ? severance.value : []).map((event) => [event.id, event]),
  );
  const documents = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const account = accounts.get(row.from_account_id);
    if (!account) {
      continue;
    }
    const target = row.target_account_id ? accounts.get(row.target_account_id) : undefined;
    // A `move` without its new account to show is left out, as one whose sender is gone.
    if (row.kind === "move" && !target) {
      continue;
    }
    const report = row.report_id ? reports.get(row.report_id) : undefined;
    // An `admin.report` whose report is gone has nothing to show.
    if (row.kind === "admin.report" && !report) {
      continue;
    }
    const event = row.severance_event_id ? events.get(row.severance_event_id) : undefined;
    // A `severed_relationships` whose event is gone has nothing to show.
    if (row.kind === "severed_relationships" && !event) {
      continue;
    }
    documents.set(row.id, {
      id: row.id,
      type: row.kind,
      created_at: row.created_at,
      account,
      status: row.status_id ? (statuses.get(row.status_id) ?? null) : null,
      ...(target ? { target } : {}),
      ...(report ? { report } : {}),
      ...(event ? { event: severanceEventDocument(event) } : {}),
    });
  }
  return documents;
};

export const mastodonNotification = async (
  env: Env,
  identity: InstanceIdentity,
  row: NotificationRow,
  viewerId: string,
): Promise<Record<string, unknown> | undefined> =>
  (await mastodonNotifications(env, identity, [row], viewerId)).get(row.id);
