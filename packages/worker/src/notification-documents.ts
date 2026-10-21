import type { InstanceIdentity } from "@tstodon/domain";
import { accountDocumentsByIds } from "./account-documents";
import { mastodonRemoteStatus, mastodonStatuses } from "./mastodon";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { findRemoteStatusesByIds } from "./remote-status-store";
import type { NotificationRow } from "./social-store";
import { findStatusesByIds } from "./status-store";

/**
 * Status documents for notifications, keyed by status id. Local and remote
 * ids share a format, so both tables are asked. A remote status only reaches
 * a notification by mentioning the recipient, so it renders for them whatever
 * its visibility.
 */
export const notificationStatusDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  ids: ReadonlyArray<string>,
  viewerId: string,
): Promise<ReadonlyMap<string, Record<string, unknown>>> => {
  const documents = new Map<string, Record<string, unknown>>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return documents;
  }
  const [locals, remotes] = await Promise.all([
    findStatusesByIds(env.DB, unique),
    findRemoteStatusesByIds(env.DB, unique),
  ]);
  if (locals.isOk()) {
    for (const document of await mastodonStatuses(
      env,
      identity,
      [...locals.value.values()],
      viewerId,
    )) {
      if (typeof document.id === "string") {
        documents.set(document.id, document);
      }
    }
  }
  if (remotes.isOk()) {
    const statuses = [...remotes.value.values()].filter((status) => !documents.has(status.id));
    const actors = await findRemoteActorsByUris(
      env.DB,
      statuses.map((status) => status.actorUri),
    );
    if (actors.isOk()) {
      for (const status of statuses) {
        const actor = actors.value.get(status.actorUri);
        if (actor) {
          documents.set(status.id, mastodonRemoteStatus(identity, status, actor));
        }
      }
    }
  }
  return documents;
};

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
    notificationStatusDocuments(
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
