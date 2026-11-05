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
  fromAccountIds: ReadonlyArray<string>;
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

const SAMPLE_ACCOUNT_LIMIT = 3;

const UNGROUPED_PREFIX = "ungrouped-";

const statusOf = (entry: GroupedNotificationEntry): string | null =>
  entry.statusId && entry.statusId.length > 0 ? entry.statusId : null;

/** Mastodon's group key: `{type}-{target}` for groupable types, else per notification. */
const key = (entry: GroupedNotificationEntry, groupedTypes: ReadonlySet<string>): string =>
  groupedTypes.has(entry.kind)
    ? `${entry.kind}-${statusOf(entry) ?? entry.fromAccountId}`
    : `${UNGROUPED_PREFIX}${entry.id}`;

/** Read a group key back into what it names; undefined for a key {@link key} never makes. */
const target = (
  groupKey: string,
  groupedTypes: ReadonlySet<string>,
): NotificationGroupTarget | undefined => {
  if (groupKey.startsWith(UNGROUPED_PREFIX)) {
    const id = groupKey.slice(UNGROUPED_PREFIX.length);
    return id.length > 0 ? { kind: "Notification", id } : undefined;
  }
  const separator = groupKey.indexOf("-");
  const type = groupKey.slice(0, separator);
  const rest = groupKey.slice(separator + 1);
  return separator > 0 && rest.length > 0 && groupedTypes.has(type)
    ? { kind: "Group", type, target: rest }
    : undefined;
};

/** One group from its notifications, newest first, within the page range. */
const group = (
  groupKey: string,
  members: ReadonlyArray<GroupedNotificationEntry>,
  rangeStart: string | undefined,
): NotificationGroup | undefined => {
  const [mostRecent] = members;
  const inRange = members.filter((entry) => rangeStart === undefined || entry.id >= rangeStart);
  const pageMin = inRange.at(-1);
  if (!mostRecent || !pageMin) {
    return undefined;
  }
  const senders = [...new Set(members.map((entry) => entry.fromAccountId))];
  return {
    groupKey,
    type: mostRecent.kind,
    notificationsCount: members.length,
    mostRecentNotificationId: mostRecent.id,
    pageMinId: pageMin.id,
    pageMaxId: mostRecent.id,
    latestPageNotificationAt: mostRecent.createdAt,
    sampleAccountIds: senders.slice(0, SAMPLE_ACCOUNT_LIMIT),
    statusId: members.map(statusOf).find((id) => id !== null) ?? null,
    reportId: mostRecent.reportId,
    severanceEventId: mostRecent.severanceEventId,
    fromAccountIds: senders,
  };
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
  const groups = order.flatMap((groupKey) => {
    const members = (byKey.get(groupKey) ?? []).filter((entry) => entry.id <= newestId);
    return group(groupKey, members, oldestId) ?? [];
  });
  const accountIds = new Set(groups.flatMap((folded) => folded.fromAccountIds));
  const statusIds = new Set(groups.flatMap((folded) => (folded.statusId ? [folded.statusId] : [])));
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
  fold,
} as const;
