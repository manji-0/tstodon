import { describe, expect, it } from "vite-plus/test";
import { type GroupedNotificationEntry, NotificationGroup } from "./notification-group";

const grouped = new Set(NotificationGroup.groupableTypes);

const entry = (
  id: string,
  kind: string,
  fromAccountId: string,
  statusId: string | null = null,
  groupKey: string | null = null,
): GroupedNotificationEntry => ({
  id,
  kind,
  fromAccountId,
  statusId,
  reportId: null,
  severanceEventId: null,
  createdAt: `2026-11-04T00:00:${id.padStart(2, "0")}.000Z`,
  groupKey,
});

describe("NotificationGroup.groupableTypes", () => {
  it("is Mastodon's GROUPABLE_NOTIFICATION_TYPES", () => {
    expect([...NotificationGroup.groupableTypes].toSorted()).toEqual([
      "admin.sign_up",
      "favourite",
      "follow",
      "reblog",
    ]);
  });
});

describe("NotificationGroup.typePrefix", () => {
  it("keys a favourite or reblog by its status and a follow or sign-up by its type", () => {
    expect(NotificationGroup.typePrefix({ kind: "favourite", statusId: "s1" })).toBe(
      "favourite-s1",
    );
    expect(NotificationGroup.typePrefix({ kind: "reblog", statusId: "s1" })).toBe("reblog-s1");
    expect(NotificationGroup.typePrefix({ kind: "follow" })).toBe("follow");
    expect(NotificationGroup.typePrefix({ kind: "admin.sign_up" })).toBe("admin.sign_up");
  });

  it("gives no prefix to a type Mastodon does not group", () => {
    for (const kind of ["mention", "follow_request", "status", "admin.report", "quote"]) {
      expect(NotificationGroup.typePrefix({ kind, statusId: "s1" })).toBeUndefined();
    }
  });
});

describe("NotificationGroup.groupKey", () => {
  // Hour bucket 493,000 starts at 2026-03-29T16:00:00Z.
  const hour = (bucket: number, minutes = 0): string =>
    new Date((bucket * 60 + minutes) * 60_000).toISOString();

  it("starts a group in the hour the notification falls in", () => {
    expect(NotificationGroup.groupKey("follow", undefined, hour(493_000, 59))).toBe(
      "follow-493000",
    );
    expect(NotificationGroup.groupKey("favourite-s1", undefined, hour(493_000))).toBe(
      "favourite-s1-493000",
    );
  });

  it("keeps the previous bucket for up to MAXIMUM_GROUP_SPAN_HOURS", () => {
    const previous = { bucket: 493_000, setAt: hour(493_011, 30) };
    expect(NotificationGroup.groupKey("follow", previous, hour(493_011, 59))).toBe("follow-493000");
    expect(NotificationGroup.groupKey("follow", previous, hour(493_012))).toBe("follow-493012");
  });

  it("forgets the previous bucket 12 hours after it was last used", () => {
    const previous = { bucket: 493_000, setAt: hour(493_000, 10) };
    expect(NotificationGroup.groupKey("follow", previous, hour(493_011, 59))).toBe("follow-493000");
    const stale = { bucket: 493_000, setAt: hour(492_999, 50) };
    expect(NotificationGroup.groupKey("follow", stale, hour(493_011, 50))).toBe("follow-493011");
  });
});

describe("NotificationGroup.key", () => {
  it("is the stored group key of a grouped type", () => {
    expect(
      NotificationGroup.key(entry("1", "favourite", "a", "s1", "favourite-s1-493000"), grouped),
    ).toBe("favourite-s1-493000");
    expect(NotificationGroup.key(entry("2", "follow", "a", null, "follow-493000"), grouped)).toBe(
      "follow-493000",
    );
  });

  it("gives a notification without a stored key its own group", () => {
    expect(NotificationGroup.key(entry("3", "mention", "a", "s1"), grouped)).toBe("ungrouped-3");
    expect(NotificationGroup.key(entry("4", "favourite", "a", "s1"), grouped)).toBe("ungrouped-4");
  });

  it("gives a type the request does not group its own group", () => {
    expect(
      NotificationGroup.key(
        entry("5", "follow", "a", null, "follow-493000"),
        new Set(["favourite"]),
      ),
    ).toBe("ungrouped-5");
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
        { id: "3", groupKey: "follow-1" },
      ],
      new Map([
        ["follow-1", summary(entry("3", "follow", "e"), ["e"])],
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
      "follow-1",
    ]);
  });

  it("leaves out a group with no summary, and is empty with none", () => {
    const representatives = [{ id: "9", groupKey: "favourite-s1" }];
    expect(NotificationGroup.page(representatives, new Map())).toEqual({ kind: "Empty" });
    expect(NotificationGroup.page([], new Map())).toEqual({ kind: "Empty" });
  });
});

describe("NotificationGroup.target", () => {
  it("names one notification for an ungrouped key and the stored key otherwise", () => {
    expect(NotificationGroup.target("ungrouped-7")).toEqual({ kind: "Notification", id: "7" });
    expect(NotificationGroup.target("favourite-s-493000")).toEqual({
      kind: "Group",
      key: "favourite-s-493000",
    });
    expect(NotificationGroup.target("nonsense")).toEqual({ kind: "Group", key: "nonsense" });
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
