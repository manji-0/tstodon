/** The fields of a stored notification that decide its group. */
export type GroupedNotificationEntry = Readonly<{
  id: string;
  kind: string;
  fromAccountId: string;
  statusId: string | null;
  reportId: string | null;
  severanceEventId: string | null;
  createdAt: string;
  /** Held by the notification policy: Mastodon gives it no group key. */
  held: boolean;
}>;

export type NotificationGroup = Readonly<{
  groupKey: string;
  type: string;
  notificationsCount: number;
  mostRecentNotificationId: string;
  /** Oldest notification of this group within the page range. */
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
}>;

/**
 * A group read in SQL, as Mastodon's `load_groups_data`: its newest
 * notification, count and newest distinct senders up to the page range's upper
 * end, and its oldest notification from the range's lower end.
 */
export type NotificationGroupSummary = Readonly<{
  newest: GroupedNotificationEntry;
  notificationsCount: number;
  pageMinId: string;
  sampleAccountIds: ReadonlyArray<string>;
}>;

/** The notification that brings a group onto a page, as `paginate_groups` picks it. */
export type NotificationGroupRepresentative = Readonly<{ id: string; groupKey: string }>;

/** One end of a page range. */
export type NotificationRangeEnd = Readonly<{ id: string; inclusive: boolean }>;

/** An `undefined` end is open. */
export type NotificationPageRange = Readonly<{
  lower: NotificationRangeEnd | undefined;
  upper: NotificationRangeEnd | undefined;
}>;

/**
 * A page. `oldestId` / `newestId` are its oldest and newest representatives:
 * the `Link` header pages on from them.
 */
export type NotificationGroupPage =
  | Readonly<{ kind: "Empty" }>
  | Readonly<{
      kind: "Page";
      groups: ReadonlyArray<NotificationGroup>;
      accountIds: ReadonlyArray<string>;
      statusIds: ReadonlyArray<string>;
      oldestId: string;
      newestId: string;
    }>;

/** `Older` pages down (`max_id`, `since_id`, or none); `Newer` pages up from `min_id`. */
export type NotificationPageDirection = "Older" | "Newer";

/** The notifications a group key names, as Mastodon's `by_group_key` scope. */
export type NotificationGroupTarget =
  | Readonly<{ kind: "Notification"; id: string }>
  | Readonly<{ kind: "Group"; type: string; target: string }>;

/**
 * Notification kinds Mastodon groups server-side (4.3+). Types outside this set
 * get their own single-notification group keyed `ungrouped-{id}`.
 */
const defaultGroupedTypes: ReadonlyArray<string> = ["favourite", "reblog", "follow"];

/** Mastodon's `GROUPABLE_NOTIFICATION_TYPES`: a request's `grouped_types` keeps only these. */
const groupableTypes: ReadonlySet<string> = new Set([...defaultGroupedTypes, "admin.sign_up"]);

/** Mastodon's `Notification::TYPES`: the types a `{type}-{target}` key can name. */
const notificationTypes: ReadonlySet<string> = new Set([
  "mention",
  "status",
  "reblog",
  "follow",
  "follow_request",
  "favourite",
  "poll",
  "update",
  "admin.sign_up",
  "admin.report",
  "severed_relationships",
  "moderation_warning",
  "annual_report",
  "quote",
  "quoted_update",
]);

const SAMPLE_ACCOUNT_LIMIT = 3;

const UNGROUPED_PREFIX = "ungrouped-";

const statusOf = (entry: GroupedNotificationEntry): string | null =>
  entry.statusId && entry.statusId.length > 0 ? entry.statusId : null;

/**
 * Mastodon's group key: `{type}-{target}` for groupable types, else per
 * notification. A held notification has no group key, so it is ungrouped.
 */
const key = (entry: GroupedNotificationEntry, groupedTypes: ReadonlySet<string>): string =>
  !entry.held && groupedTypes.has(entry.kind)
    ? `${entry.kind}-${statusOf(entry) ?? entry.fromAccountId}`
    : `${UNGROUPED_PREFIX}${entry.id}`;

/**
 * Read a group key back into what it names, as Mastodon's `by_group_key`:
 * whatever types the request groups. Undefined for a key no notification type
 * makes.
 */
const target = (groupKey: string): NotificationGroupTarget | undefined => {
  if (groupKey.startsWith(UNGROUPED_PREFIX)) {
    const id = groupKey.slice(UNGROUPED_PREFIX.length);
    return id.length > 0 ? { kind: "Notification", id } : undefined;
  }
  const separator = groupKey.indexOf("-");
  const type = groupKey.slice(0, separator);
  const rest = groupKey.slice(separator + 1);
  return separator > 0 && rest.length > 0 && notificationTypes.has(type)
    ? { kind: "Group", type, target: rest }
    : undefined;
};

const summarized = (groupKey: string, summary: NotificationGroupSummary): NotificationGroup => ({
  groupKey,
  type: summary.newest.kind,
  notificationsCount: summary.notificationsCount,
  mostRecentNotificationId: summary.newest.id,
  pageMinId: summary.pageMinId,
  pageMaxId: summary.newest.id,
  latestPageNotificationAt: summary.newest.createdAt,
  sampleAccountIds: summary.sampleAccountIds.slice(0, SAMPLE_ACCOUNT_LIMIT),
  statusId: statusOf(summary.newest),
  reportId: summary.newest.reportId,
  severanceEventId: summary.newest.severanceEventId,
});

/**
 * The range a page's groups are read within, as Mastodon's
 * `load_grouped_notifications`: from the oldest to the newest representative
 * (newest first in `representatives`). A page with fewer than `limit` groups
 * is the last one its way, so the range stays open on that side, up to
 * `max_id` when paging up and down to `since_id` when paging down.
 */
const pageRange = (
  representatives: ReadonlyArray<NotificationGroupRepresentative>,
  limit: number,
  direction: NotificationPageDirection,
  cursor: Readonly<{ maxId?: string | undefined; sinceId?: string | undefined }>,
): NotificationPageRange => {
  const newest = representatives.at(0);
  const oldest = representatives.at(-1);
  const lower = oldest ? { id: oldest.id, inclusive: true } : undefined;
  const upper = newest ? { id: newest.id, inclusive: true } : undefined;
  if (representatives.length >= limit) {
    return { lower, upper };
  }
  return direction === "Newer"
    ? { lower, upper: cursor.maxId ? { id: cursor.maxId, inclusive: false } : undefined }
    : { lower: cursor.sinceId ? { id: cursor.sinceId, inclusive: false } : undefined, upper };
};

/**
 * A page from its representatives, newest first, and the summaries of their
 * groups. A group without a summary (nothing of it is visible any more) is
 * left out. The envelope carries the groups' sample accounts and statuses.
 */
const page = (
  representatives: ReadonlyArray<NotificationGroupRepresentative>,
  summaries: ReadonlyMap<string, NotificationGroupSummary>,
): NotificationGroupPage => {
  const groups = representatives.flatMap((representative) => {
    const summary = summaries.get(representative.groupKey);
    return summary ? [summarized(representative.groupKey, summary)] : [];
  });
  const newest = representatives.at(0);
  const oldest = representatives.at(-1);
  if (groups.length === 0 || !newest || !oldest) {
    return { kind: "Empty" };
  }
  return {
    kind: "Page",
    groups,
    accountIds: [...new Set(groups.flatMap((group) => group.sampleAccountIds))],
    statusIds: [...new Set(groups.flatMap((group) => (group.statusId ? [group.statusId] : [])))],
    oldestId: oldest.id,
    newestId: newest.id,
  };
};

export const NotificationGroup = {
  defaultGroupedTypes,
  groupableTypes,
  key,
  target,
  summarized,
  pageRange,
  page,
} as const;
