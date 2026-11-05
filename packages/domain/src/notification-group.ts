/** The fields of a stored notification that decide its group. */
export type GroupedNotificationEntry = Readonly<{
  id: string;
  kind: string;
  fromAccountId: string;
  statusId: string | null;
  reportId: string | null;
  severanceEventId: string | null;
  createdAt: string;
}>;

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
  /** The report an `admin.report` group points at. */
  reportId: string | null;
  /** The account's severance event a `severed_relationships` group reports. */
  severanceEventId: string | null;
  notificationIds: ReadonlyArray<string>;
  fromAccountIds: ReadonlyArray<string>;
}>;

export type NotificationGroupPage = Readonly<{
  groups: ReadonlyArray<NotificationGroup>;
  accountIds: ReadonlyArray<string>;
  statusIds: ReadonlyArray<string>;
}>;

/**
 * Notification kinds Mastodon groups server-side (4.3+). Types outside this set
 * get their own single-notification group keyed `ungrouped-{id}`.
 */
const defaultGroupedTypes: ReadonlyArray<string> = ["favourite", "reblog", "follow"];

const SAMPLE_ACCOUNT_LIMIT = 3;

const statusOf = (entry: GroupedNotificationEntry): string | null =>
  entry.statusId && entry.statusId.length > 0 ? entry.statusId : null;

/** Mastodon's group key: `{type}-{target}` for groupable types, else per notification. */
const key = (entry: GroupedNotificationEntry, groupedTypes: ReadonlySet<string>): string =>
  groupedTypes.has(entry.kind)
    ? `${entry.kind}-${statusOf(entry) ?? entry.fromAccountId}`
    : `ungrouped-${entry.id}`;

/**
 * Fold a newest-first page of notifications into groups, preserving that order
 * and stopping after `limit` groups (Mastodon counts `limit` in groups). Every
 * entry is folded in first so a group's counts cover the whole page.
 */
const fold = (
  entries: ReadonlyArray<GroupedNotificationEntry>,
  groupedTypes: ReadonlySet<string>,
  limit: number,
): NotificationGroupPage => {
  const order: string[] = [];
  const byKey = new Map<string, NotificationGroup>();
  const samples = new Map<string, string[]>();
  const senders = new Map<string, string[]>();

  for (const entry of entries) {
    const groupKey = key(entry, groupedTypes);
    const existing = byKey.get(groupKey);
    if (!existing) {
      order.push(groupKey);
      samples.set(groupKey, [entry.fromAccountId]);
      senders.set(groupKey, [entry.fromAccountId]);
      byKey.set(groupKey, {
        groupKey,
        type: entry.kind,
        notificationsCount: 1,
        mostRecentNotificationId: entry.id,
        pageMinId: entry.id,
        pageMaxId: entry.id,
        latestPageNotificationAt: entry.createdAt,
        sampleAccountIds: [entry.fromAccountId],
        statusId: statusOf(entry),
        reportId: entry.reportId,
        severanceEventId: entry.severanceEventId,
        notificationIds: [entry.id],
        fromAccountIds: [entry.fromAccountId],
      });
      continue;
    }
    const sample = samples.get(groupKey) ?? [];
    if (!sample.includes(entry.fromAccountId) && sample.length < SAMPLE_ACCOUNT_LIMIT) {
      sample.push(entry.fromAccountId);
    }
    const all = senders.get(groupKey) ?? [];
    if (!all.includes(entry.fromAccountId)) {
      all.push(entry.fromAccountId);
    }
    byKey.set(groupKey, {
      ...existing,
      notificationsCount: existing.notificationsCount + 1,
      // Entries arrive newest first, so the first id seen is the max and the
      // last one processed is the min.
      pageMinId: entry.id < existing.pageMinId ? entry.id : existing.pageMinId,
      statusId: existing.statusId ?? statusOf(entry),
      sampleAccountIds: [...sample],
      notificationIds: [...existing.notificationIds, entry.id],
      fromAccountIds: [...all],
    });
  }

  const groups = order.slice(0, Math.max(limit, 0)).flatMap((groupKey) => {
    const group = byKey.get(groupKey);
    return group ? [group] : [];
  });
  const accountIds = new Set(groups.flatMap((group) => group.fromAccountIds));
  const statusIds = new Set(groups.flatMap((group) => (group.statusId ? [group.statusId] : [])));
  return { groups, accountIds: [...accountIds], statusIds: [...statusIds] };
};

export const NotificationGroup = {
  defaultGroupedTypes,
  key,
  fold,
} as const;
