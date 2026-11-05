import { describe, expect, it } from "vite-plus/test";
import {
  type GroupedNotificationEntry,
  NotificationGroup,
  type NotificationGroupPage,
} from "./notification-group";

const grouped = new Set(NotificationGroup.defaultGroupedTypes);

const entry = (
  id: string,
  kind: string,
  fromAccountId: string,
  statusId: string | null = null,
): GroupedNotificationEntry => ({
  id,
  kind,
  fromAccountId,
  statusId,
  reportId: null,
  severanceEventId: null,
  createdAt: `2026-11-04T00:00:${id.padStart(2, "0")}.000Z`,
});

describe("NotificationGroup.key", () => {
  it("groups a groupable kind by its status, or by sender without one", () => {
    expect(NotificationGroup.key(entry("1", "favourite", "a", "s1"), grouped)).toBe("favourite-s1");
    expect(NotificationGroup.key(entry("2", "follow", "a", ""), grouped)).toBe("follow-a");
  });

  it("gives every other kind its own group", () => {
    expect(NotificationGroup.key(entry("3", "mention", "a", "s1"), grouped)).toBe("ungrouped-3");
  });
});

describe("NotificationGroup.fold", () => {
  const page = [
    entry("9", "favourite", "a", "s1"),
    entry("8", "mention", "b", "s2"),
    entry("7", "favourite", "b", "s1"),
    entry("6", "favourite", "c", "s1"),
    entry("5", "favourite", "d", "s1"),
    entry("4", "favourite", "a", "s1"),
    entry("3", "follow", "e"),
  ];

  const groupsOf = (folded: NotificationGroupPage): ReadonlyArray<NotificationGroup> =>
    folded.kind === "Page" ? folded.groups : [];

  it("folds a newest-first page into groups in first-seen order", () => {
    const groups = groupsOf(NotificationGroup.fold(page, grouped, 40));
    expect(groups.map((group) => group.groupKey)).toEqual([
      "favourite-s1",
      "ungrouped-8",
      "follow-e",
    ]);
    const favourites = groups[0];
    expect(favourites).toMatchObject({
      notificationsCount: 5,
      mostRecentNotificationId: "9",
      pageMaxId: "9",
      pageMinId: "4",
      latestPageNotificationAt: "2026-11-04T00:00:09.000Z",
      sampleAccountIds: ["a", "b", "c"],
      fromAccountIds: ["a", "b", "c", "d"],
    });
  });

  it("counts the limit in groups and collects only their accounts and statuses", () => {
    const folded = NotificationGroup.fold(page, grouped, 2);
    expect(folded).toMatchObject({
      kind: "Page",
      accountIds: ["a", "b", "c", "d"],
      statusIds: ["s1", "s2"],
    });
    expect(groupsOf(folded)).toHaveLength(2);
    expect(NotificationGroup.fold(page, grouped, -1)).toEqual({ kind: "Empty" });
    expect(NotificationGroup.fold([], grouped, 40)).toEqual({ kind: "Empty" });
  });

  it("ends a full page at the last group's first notification", () => {
    // As Mastodon's pagination range: only `page_min_id` is bounded by the
    // range start, so the next page reads on from the last group's first one.
    const folded = NotificationGroup.fold(page, grouped, 2);
    expect(folded).toMatchObject({ kind: "Page", oldestId: "8", newestId: "9" });
    expect(
      groupsOf(folded).map((group) => [group.groupKey, group.pageMinId, group.pageMaxId]),
    ).toEqual([
      ["favourite-s1", "9", "9"],
      ["ungrouped-8", "8", "8"],
    ]);
  });

  it("counts a group's notifications older than the page range start", () => {
    // Mastodon's `load_groups_data` bounds count and samples by the upper end only.
    const groups = groupsOf(
      NotificationGroup.fold(
        [entry("3", "favourite", "a", "s1"), entry("2", "favourite", "b", "s2"), entry("1", "favourite", "c", "s1")],
        grouped,
        2,
      ),
    );
    expect(groups.map((group) => [group.groupKey, group.notificationsCount])).toEqual([
      ["favourite-s1", 2],
      ["favourite-s2", 1],
    ]);
    expect(groups[0]).toMatchObject({ pageMinId: "3", sampleAccountIds: ["a", "c"] });
  });

  describe("paging up from min_id", () => {
    // Newest first, as the route hands them over after reversing a `min_id` read.
    const upward = [
      entry("4", "favourite", "c", "s3"),
      entry("3", "favourite", "a", "s1"),
      entry("2", "favourite", "b", "s2"),
      entry("1", "favourite", "a", "s1"),
    ];

    it("takes the groups next to min_id and returns them newest first", () => {
      const folded = NotificationGroup.fold(upward, grouped, 2, "Newer");
      expect(folded).toMatchObject({ kind: "Page", oldestId: "1", newestId: "2" });
      expect(
        groupsOf(folded).map((group) => [
          group.groupKey,
          group.mostRecentNotificationId,
          group.notificationsCount,
        ]),
      ).toEqual([
        ["favourite-s2", "2", 1],
        ["favourite-s1", "1", 1],
      ]);
    });

    it("reports each group's newest notification as its most recent", () => {
      const groups = groupsOf(NotificationGroup.fold(upward, grouped, 40, "Newer"));
      expect(
        groups.map((group) => [
          group.groupKey,
          group.mostRecentNotificationId,
          group.pageMaxId,
          group.pageMinId,
        ]),
      ).toEqual([
        ["favourite-s3", "4", "4", "4"],
        ["favourite-s2", "2", "2", "2"],
        ["favourite-s1", "3", "3", "1"],
      ]);
    });
  });
});

describe("NotificationGroup.target", () => {
  it("names one notification for an ungrouped key and a type and target otherwise", () => {
    expect(NotificationGroup.target("ungrouped-7", grouped)).toEqual({
      kind: "Notification",
      id: "7",
    });
    expect(NotificationGroup.target("favourite-s-1", grouped)).toEqual({
      kind: "Group",
      type: "favourite",
      target: "s-1",
    });
    expect(NotificationGroup.target("mention-s1", grouped)).toBeUndefined();
    expect(NotificationGroup.target("favourite-", grouped)).toBeUndefined();
  });
});
