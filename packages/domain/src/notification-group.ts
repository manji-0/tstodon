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

/** A group read by key in SQL: its newest notification, count and oldest id. */
export type NotificationGroupSummary = Readonly<{
  newest: GroupedNotificationEntry;
  notificationsCount: number;
  oldestId: string;
}>;

/**
 * A folded page. `oldestId` / `newestId` bound the notifications it covers:
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

/**
 * A group from its summary and its senders' account ids, newest first: the
 * first {@link SAMPLE_ACCOUNT_LIMIT} distinct senders are its sample.
 */
const summarized = (
  groupKey: string,
  summary: NotificationGroupSummary,
  senders: ReadonlyArray<string>,
): NotificationGroup => ({
  groupKey,
  type: summary.newest.kind,
  notificationsCount: summary.notificationsCount,
  mostRecentNotificationId: summary.newest.id,
  pageMinId: summary.oldestId,
  pageMaxId: summary.newest.id,
  latestPageNotificationAt: summary.newest.createdAt,
  sampleAccountIds: [...new Set(senders)].slice(0, SAMPLE_ACCOUNT_LIMIT),
  statusId: statusOf(summary.newest),
  reportId: summary.newest.reportId,
  severanceEventId: summary.newest.severanceEventId,
});

/** One group from its notifications, newest first, within the page range. */
const group = (
  groupKey: string,
  members: ReadonlyArray<GroupedNotificationEntry>,
  rangeStart: string | undefined,
): NotificationGroup | undefined => {
  const [mostRecent] = members;
  const pageMin = members.findLast((entry) => rangeStart === undefined || entry.id >= rangeStart);
  if (!mostRecent || !pageMin) {
    return undefined;
  }
  return summarized(
    groupKey,
    { newest: mostRecent, notificationsCount: members.length, oldestId: pageMin.id },
    members.map((entry) => entry.fromAccountId),
  );
};

/**
 * Fold a newest-first window of notifications into at most `limit` groups, as
 * Mastodon's `paginate_groups` and `NotificationGroup.from_notifications`.
 *
 * The page takes the first `limit` groups met reading away from the cursor:
 * from the newest end for `Older`, from the oldest end for `Newer`, each group
 * met at its first notification on that side. A full page's range ends at the
 * last group met; with fewer groups it spans the window. As Mastodon's
 * `load_groups_data`, only `pageMinId` is bounded by the range's oldest end:
 * counts, samples and the most recent notification take every notification of
 * the group up to the range's newest end. Groups come back newest first,
 * ordered by the notification each was met at.
 */
const fold = (
  entries: ReadonlyArray<GroupedNotificationEntry>,
  groupedTypes: ReadonlySet<string>,
  limit: number,
  direction: NotificationPageDirection = "Older",
): NotificationGroupPage => {
  const byKey = new Map<string, GroupedNotificationEntry[]>();
  for (const entry of entries) {
    const groupKey = key(entry, groupedTypes);
    byKey.set(groupKey, [...(byKey.get(groupKey) ?? []), entry]);
  }

  const met = new Map<string, GroupedNotificationEntry>();
  for (const entry of direction === "Older" ? entries : entries.toReversed()) {
    const groupKey = key(entry, groupedTypes);
    if (met.has(groupKey)) {
      continue;
    }
    if (met.size >= limit) {
      break;
    }
    met.set(groupKey, entry);
  }

  const first = entries.at(0);
  const last = entries.at(-1);
  if (met.size === 0 || !first || !last) {
    return { kind: "Empty" };
  }
  const end = met.size === limit ? [...met.values()].at(-1)?.id : undefined;
  const oldestId = direction === "Older" ? (end ?? last.id) : last.id;
  const newestId = direction === "Newer" ? (end ?? first.id) : first.id;

  const order = direction === "Older" ? [...met.keys()] : [...met.keys()].toReversed();
  const folded = order.flatMap((groupKey) => {
    const members = (byKey.get(groupKey) ?? []).filter((entry) => entry.id <= newestId);
    const built = group(groupKey, members, oldestId);
    return built ? [{ group: built, senders: members.map((entry) => entry.fromAccountId) }] : [];
  });
  const groups = folded.map((entry) => entry.group);
  const accountIds = new Set(folded.flatMap((entry) => entry.senders));
  const statusIds = new Set(groups.flatMap((built) => (built.statusId ? [built.statusId] : [])));
  return {
    kind: "Page",
    groups,
    accountIds: [...accountIds],
    statusIds: [...statusIds],
    oldestId,
    newestId,
  };
};

export const NotificationGroup = {
  defaultGroupedTypes,
  key,
  target,
  summarized,
  fold,
} as const;
