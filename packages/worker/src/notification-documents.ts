import type { InstanceIdentity } from "@tstodon/domain";
import { accountDocumentsByIds } from "./account-documents";
import type { NotificationRow } from "./social-store";
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
  const [accounts, statuses] = await Promise.all([
    accountDocumentsByIds(
      env,
      identity,
      rows.map((row) => row.from_account_id),
    ),
    statusDocumentsByIds(
      env,
      identity,
      rows.flatMap((row) => (row.status_id ? [row.status_id] : [])),
      viewerId,
    ),
  ]);
  const documents = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const account = accounts.get(row.from_account_id);
    if (!account) {
      continue;
    }
    documents.set(row.id, {
      id: row.id,
      type: row.kind,
      created_at: row.created_at,
      account,
      status: row.status_id ? (statuses.get(row.status_id) ?? null) : null,
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
