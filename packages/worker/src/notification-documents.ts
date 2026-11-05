import { AccountPresentation, type InstanceIdentity } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { presentedAccountsByIds } from "./account-documents";
import type { RepositoryError } from "./d1";
import { reportDocumentsByIds } from "./report-documents";
import { findAccountSeveranceEvents, severanceEventDocument } from "./severed-relationship-store";
import type { NotificationRow } from "./notification-store";
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
): Promise<Result<ReadonlyMap<string, Record<string, unknown>>, RepositoryError>> => {
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
  const accounts = presented.value;
  const reports = reported.value;
  const events = new Map(
    (severance.isOk() ? severance.value : []).map((event) => [event.id, event]),
  );
  const documents = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const sender = accounts.get(row.from_account_id);
    // As Mastodon's `without_suspended`, a sender that is not available hides the notification.
    if (!sender || !AccountPresentation.available(sender.presentation)) {
      continue;
    }
    const account = sender.document;
    const target = row.target_account_id
      ? accounts.get(row.target_account_id)?.document
      : undefined;
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
  return ok(documents);
};

export const mastodonNotification = async (
  env: Env,
  identity: InstanceIdentity,
  row: NotificationRow,
  viewerId: string,
): Promise<Result<Record<string, unknown> | undefined, RepositoryError>> =>
  (await mastodonNotifications(env, identity, [row], viewerId)).map((documents) =>
    documents.get(row.id),
  );
