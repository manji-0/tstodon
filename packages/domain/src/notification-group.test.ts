import { describe, expect, it } from "vite-plus/test";
import { type GroupedNotificationEntry, NotificationGroup } from "./notification-group";

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

  it("folds a newest-first page into groups in first-seen order", () => {
    const { groups } = NotificationGroup.fold(page, grouped, 40);
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
      notificationIds: ["9", "7", "6", "5", "4"],
    });
  });

  it("counts the limit in groups and collects only their accounts and statuses", () => {
    const folded = NotificationGroup.fold(page, grouped, 2);
    expect(folded.groups).toHaveLength(2);
    expect(folded.accountIds).toEqual(["a", "b"]);
    expect(folded.statusIds).toEqual(["s1", "s2"]);
    expect(NotificationGroup.fold(page, grouped, -1).groups).toEqual([]);
  });

  it("ends a full page at the last group's first notification", () => {
    // As Mastodon's pagination range: the older notifications of a group on a
    // full page belong to the next page, which also holds the groups left off.
    const { groups } = NotificationGroup.fold(page, grouped, 2);
    expect(groups.map((group) => [group.groupKey, group.pageMinId, group.pageMaxId])).toEqual([
      ["favourite-s1", "9", "9"],
      ["ungrouped-8", "8", "8"],
    ]);
    expect(groups[0]?.notificationsCount).toBe(1);
  });
});
