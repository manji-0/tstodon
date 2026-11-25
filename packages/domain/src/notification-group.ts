/** The fields of a stored notification that decide its group. */
export type GroupedNotificationEntry = Readonly<{
  id: string;
  kind: string;
  fromAccountId: string;
  statusId: string | null;
  reportId: string | null;
  severanceEventId: string | null;
  collectionId: string | null;
  collectionItemId: string | null;
  createdAt: string;
  /**
   * The key stored when it was recorded: `{typePrefix}-{hourBucket}` for a
   * groupable type, none for another type or one the policy held.
   */
  groupKey: string | null;
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
  /** The collection (or its item) an `added_to_collection` or `collection_update` group is about. */
  collectionId: string | null;
  collectionItemId: string | null;
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

/**
 * The notifications a group key names, as Mastodon's `by_group_key` scope:
 * one by id for `ungrouped-{id}`, else those that stored the key.
 */
export type NotificationGroupTarget =
  | Readonly<{ kind: "Notification"; id: string }>
  | Readonly<{ kind: "Group"; key: string }>;

/**
 * The group a type prefix's last notification went to, as Mastodon keeps it
 * in Redis: its hour bucket, and when it was recorded.
 */
export type PreviousGroupBucket = Readonly<{ bucket: number; setAt: string }>;

/**
 * Mastodon's `GROUPABLE_NOTIFICATION_TYPES`: the types that get a group key,
 * the ones a request's `grouped_types` keeps, and the ones grouped when it
 * names none. Every other type gets its own group keyed `ungrouped-{id}`.
 */
const groupableTypes: ReadonlySet<string> = new Set([
  "favourite",
  "reblog",
  "follow",
  "admin.sign_up",
]);

/** Mastodon's `MAXIMUM_GROUP_SPAN_HOURS`. */
const MAXIMUM_GROUP_SPAN_HOURS = 12;

const HOUR_MS = 3_600_000;

const SAMPLE_ACCOUNT_LIMIT = 3;

const UNGROUPED_PREFIX = "ungrouped-";

const statusOf = (entry: GroupedNotificationEntry): string | null =>
  entry.statusId && entry.statusId.length > 0 ? entry.statusId : null;

/**
 * Mastodon's `type_prefix` in `set_group_key!`: a favourite or reblog is
 * grouped by its status, a follow or sign-up by its type alone. Undefined for
 * a type that is not grouped.
 */
const typePrefix = (
  notification: Readonly<{ kind: string; statusId?: string | undefined }>,
): string | undefined => {
  switch (notification.kind) {
    case "favourite":
    case "reblog":
      return `${notification.kind}-${notification.statusId ?? ""}`;
    case "follow":
    case "admin.sign_up":
      return notification.kind;
    default:
      return undefined;
  }
};

/**
 * Mastodon's `set_group_key!` for a notification recorded `at`: the hour
 * bucket it falls in, or the previous one of its type prefix while that was
 * used within the last `MAXIMUM_GROUP_SPAN_HOURS` (its Redis expiry) and
 * began less than that many hours before.
 */
const groupKey = (
  prefix: string,
  previous: PreviousGroupBucket | undefined,
  at: string,
): string => {
  const now = Date.parse(at);
  const hourBucket = Math.floor(now / HOUR_MS);
  const live =
    previous !== undefined && now < Date.parse(previous.setAt) + MAXIMUM_GROUP_SPAN_HOURS * HOUR_MS;
  const previousBucket = live ? previous.bucket : 0;
  const bucket =
    hourBucket < previousBucket + MAXIMUM_GROUP_SPAN_HOURS ? previousBucket : hourBucket;
  return `${prefix}-${bucket}`;
};

/**
 * A notification's group in a list that groups `groupedTypes`, as Mastodon's
 * `paginate_groups`: its stored key, or a group of its own.
 */
const key = (entry: GroupedNotificationEntry, groupedTypes: ReadonlySet<string>): string =>
  entry.groupKey !== null && groupedTypes.has(entry.kind)
    ? entry.groupKey
    : `${UNGROUPED_PREFIX}${entry.id}`;

/** Read a group key back into what it names, as Mastodon's `by_group_key`. */
const target = (groupKey: string): NotificationGroupTarget =>
  groupKey.startsWith(UNGROUPED_PREFIX)
    ? { kind: "Notification", id: groupKey.slice(UNGROUPED_PREFIX.length) }
    : { kind: "Group", key: groupKey };

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
  collectionId: summary.newest.collectionId,
  collectionItemId: summary.newest.collectionItemId,
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
  groupableTypes,
  typePrefix,
  groupKey,
  key,
  target,
  summarized,
  pageRange,
  page,
} as const;
