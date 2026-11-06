import { describe, expect, it } from "vite-plus/test";
import { type GroupedNotificationEntry, NotificationGroup } from "./notification-group";

const grouped = new Set(NotificationGroup.defaultGroupedTypes);

const entry = (
  id: string,
  kind: string,
  fromAccountId: string,
  statusId: string | null = null,
  held = false,
): GroupedNotificationEntry => ({
  id,
  kind,
  fromAccountId,
  statusId,
  reportId: null,
  severanceEventId: null,
  createdAt: `2026-11-04T00:00:${id.padStart(2, "0")}.000Z`,
  held,
});

describe("NotificationGroup.key", () => {
  it("groups a groupable kind by its status, or by sender without one", () => {
    expect(NotificationGroup.key(entry("1", "favourite", "a", "s1"), grouped)).toBe("favourite-s1");
    expect(NotificationGroup.key(entry("2", "follow", "a", ""), grouped)).toBe("follow-a");
  });

  it("gives every other kind its own group", () => {
    expect(NotificationGroup.key(entry("3", "mention", "a", "s1"), grouped)).toBe("ungrouped-3");
  });

  it("gives a held notification its own group, as Mastodon gives it no group key", () => {
    expect(NotificationGroup.key(entry("4", "favourite", "a", "s1", true), grouped)).toBe(
      "ungrouped-4",
    );
  });
});

describe("NotificationGroup.pageRange", () => {
  const representatives = [
    { id: "9", groupKey: "favourite-s1" },
    { id: "5", groupKey: "ungrouped-5" },
  ];

  it("spans a full page from its oldest to its newest representative", () => {
    expect(NotificationGroup.pageRange(representatives, 2, "Older", {})).toEqual({
      lower: { id: "5", inclusive: true },
      upper: { id: "9", inclusive: true },
    });
    expect(NotificationGroup.pageRange(representatives, 2, "Newer", { maxId: "20" })).toEqual({
      lower: { id: "5", inclusive: true },
      upper: { id: "9", inclusive: true },
    });
  });

  it("leaves the far side of a last page open, down to since_id or up to max_id", () => {
    expect(NotificationGroup.pageRange(representatives, 40, "Older", {})).toEqual({
      lower: undefined,
      upper: { id: "9", inclusive: true },
    });
    expect(NotificationGroup.pageRange(representatives, 40, "Older", { sinceId: "2" })).toEqual({
      lower: { id: "2", inclusive: false },
      upper: { id: "9", inclusive: true },
    });
    expect(NotificationGroup.pageRange(representatives, 40, "Newer", {})).toEqual({
      lower: { id: "5", inclusive: true },
      upper: undefined,
    });
    expect(NotificationGroup.pageRange(representatives, 40, "Newer", { maxId: "20" })).toEqual({
      lower: { id: "5", inclusive: true },
      upper: { id: "20", inclusive: false },
    });
  });
});

describe("NotificationGroup.page", () => {
  const summary = (newest: GroupedNotificationEntry, senders: ReadonlyArray<string>) => ({
    newest,
    notificationsCount: senders.length,
    pageMinId: newest.id,
    sampleAccountIds: senders,
  });

  it("orders groups by representative and carries their samples and statuses", () => {
    const page = NotificationGroup.page(
      [
        { id: "9", groupKey: "favourite-s1" },
        { id: "8", groupKey: "ungrouped-8" },
        { id: "3", groupKey: "follow-e" },
      ],
      new Map([
        ["follow-e", summary(entry("3", "follow", "e"), ["e"])],
        ["favourite-s1", summary(entry("9", "favourite", "a", "s1"), ["a", "b"])],
        ["ungrouped-8", summary(entry("8", "mention", "b", "s2"), ["b"])],
      ]),
    );
    expect(page).toMatchObject({
      kind: "Page",
      accountIds: ["a", "b", "e"],
      statusIds: ["s1", "s2"],
      oldestId: "3",
      newestId: "9",
    });
    expect(page.kind === "Page" ? page.groups.map((group) => group.groupKey) : []).toEqual([
      "favourite-s1",
      "ungrouped-8",
      "follow-e",
    ]);
  });

  it("leaves out a group with no summary, and is empty with none", () => {
    const representatives = [{ id: "9", groupKey: "favourite-s1" }];
    expect(NotificationGroup.page(representatives, new Map())).toEqual({ kind: "Empty" });
    expect(NotificationGroup.page([], new Map())).toEqual({ kind: "Empty" });
  });
});

describe("NotificationGroup.target", () => {
  it("names one notification for an ungrouped key and a type and target otherwise", () => {
    expect(NotificationGroup.target("ungrouped-7")).toEqual({
      kind: "Notification",
      id: "7",
    });
    expect(NotificationGroup.target("favourite-s-1")).toEqual({
      kind: "Group",
      type: "favourite",
      target: "s-1",
    });
    expect(NotificationGroup.target("mention-s1")).toEqual({
      kind: "Group",
      type: "mention",
      target: "s1",
    });
    expect(NotificationGroup.target("nonsense-s1")).toBeUndefined();
    expect(NotificationGroup.target("favourite-")).toBeUndefined();
  });
});

describe("NotificationGroup.summarized", () => {
  it("builds a group from its count, page bounds, newest notification and samples", () => {
    const group = NotificationGroup.summarized("favourite-s1", {
      newest: entry("9", "favourite", "a", "s1"),
      notificationsCount: 120,
      pageMinId: "1",
      sampleAccountIds: ["a", "b", "c", "d"],
    });
    expect(group).toEqual({
      groupKey: "favourite-s1",
      type: "favourite",
      notificationsCount: 120,
      mostRecentNotificationId: "9",
      pageMinId: "1",
      pageMaxId: "9",
      latestPageNotificationAt: "2026-11-04T00:00:09.000Z",
      sampleAccountIds: ["a", "b", "c"],
      statusId: "s1",
      reportId: null,
      severanceEventId: null,
    });
  });
});
