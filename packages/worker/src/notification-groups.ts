import type { NotificationRow } from "./notification-store";

/**
 * Notification kinds Mastodon groups server-side (4.3+). Types outside this set
 * get their own single-notification group keyed `ungrouped-{id}`.
 */
export const DEFAULT_GROUPED_TYPES: ReadonlyArray<string> = ["favourite", "reblog", "follow"];

export type NotificationGroup = Readonly<{
  groupKey: string;
  type: string;
  notificationsCount: number;
  mostRecentNotificationId: string;
  /** Oldest / newest notification of this group within the page. */
  pageMinId: string;
  pageMaxId: string;
  latestPageNotificationAt: string;
  /** Up to three most recent senders, newest first. */
  sampleAccountIds: ReadonlyArray<string>;
  statusId: string | null;
  notificationIds: ReadonlyArray<string>;
  fromAccountIds: ReadonlyArray<string>;
}>;

const SAMPLE_ACCOUNT_LIMIT = 3;

/** Mastodon's group key: `{type}-{target}` for groupable types, else per notification. */
export const notificationGroupKey = (
  row: NotificationRow,
  groupedTypes: ReadonlySet<string>,
): string => {
  if (!groupedTypes.has(row.kind)) {
    return `ungrouped-${row.id}`;
  }
  const target = row.status_id && row.status_id.length > 0 ? row.status_id : row.from_account_id;
  return `${row.kind}-${target}`;
};

/**
 * Fold a newest-first page of notifications into groups, preserving that order
 * and stopping after `limit` groups (Mastodon counts `limit` in groups). Every
 * row is folded in first so a group's counts cover the whole page.
 */
export const groupNotifications = (
  rows: ReadonlyArray<NotificationRow>,
  groupedTypes: ReadonlySet<string>,
  limit: number,
): Readonly<{
  groups: ReadonlyArray<NotificationGroup>;
  accountIds: ReadonlyArray<string>;
  statusIds: ReadonlyArray<string>;
}> => {
  const order: string[] = [];
  const byKey = new Map<string, NotificationGroup>();
  const samples = new Map<string, string[]>();
  const senders = new Map<string, string[]>();

  for (const row of rows) {
    const key = notificationGroupKey(row, groupedTypes);
    const existing = byKey.get(key);
    if (!existing) {
      order.push(key);
      samples.set(key, [row.from_account_id]);
      senders.set(key, [row.from_account_id]);
      byKey.set(key, {
        groupKey: key,
        type: row.kind,
        notificationsCount: 1,
        mostRecentNotificationId: row.id,
        pageMinId: row.id,
        pageMaxId: row.id,
        latestPageNotificationAt: row.created_at,
        sampleAccountIds: [row.from_account_id],
        statusId: row.status_id && row.status_id.length > 0 ? row.status_id : null,
        notificationIds: [row.id],
        fromAccountIds: [row.from_account_id],
      });
      continue;
    }
    const sample = samples.get(key) ?? [];
    if (!sample.includes(row.from_account_id) && sample.length < SAMPLE_ACCOUNT_LIMIT) {
      sample.push(row.from_account_id);
    }
    const all = senders.get(key) ?? [];
    if (!all.includes(row.from_account_id)) {
      all.push(row.from_account_id);
    }
    byKey.set(key, {
      ...existing,
      notificationsCount: existing.notificationsCount + 1,
      // Rows arrive newest first, so the first id seen is the max and the last
      // one processed is the min.
      pageMinId: row.id < existing.pageMinId ? row.id : existing.pageMinId,
      statusId:
        existing.statusId ?? (row.status_id && row.status_id.length > 0 ? row.status_id : null),
      sampleAccountIds: [...sample],
      notificationIds: [...existing.notificationIds, row.id],
      fromAccountIds: [...all],
    });
  }

  const groups = order.slice(0, Math.max(limit, 0)).flatMap((key) => {
    const group = byKey.get(key);
    return group ? [group] : [];
  });
  const accountIds = new Set<string>();
  const statusIds = new Set<string>();
  for (const group of groups) {
    for (const id of group.fromAccountIds) {
      accountIds.add(id);
    }
    if (group.statusId) {
      statusIds.add(group.statusId);
    }
  }
  return { groups, accountIds: [...accountIds], statusIds: [...statusIds] };
};
