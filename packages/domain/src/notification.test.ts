import { describe, expect, it } from "vitest";
import { AccountId } from "./account-id";
import { Notification } from "./notification";
import { StatusId } from "./status-id";

describe("Notification", () => {
  it("parses each kind variant", () => {
    const accountId = AccountId.parse("acct-1");
    const statusId = StatusId.parse("status-1");
    expect(accountId.isOk() && statusId.isOk()).toBe(true);
    if (!accountId.isOk() || !statusId.isOk()) {
      return;
    }
    const base = {
      id: "notif-1",
      accountId: accountId.value,
      createdAt: "2026-01-01T00:00:00.000Z",
    } as const;

    const follow = Notification.parse({ kind: "follow", ...base });
    expect(follow.isOk()).toBe(true);
    if (follow.isOk()) {
      expect(follow.value.kind).toBe("follow");
    }

    for (const kind of ["favourite", "reblog", "mention", "poll"] as const) {
      const parsed = Notification.parse({ kind, ...base, statusId: statusId.value });
      expect(parsed.isOk()).toBe(true);
      if (parsed.isOk()) {
        expect(parsed.value.kind).toBe(kind);
      }
    }
  });

  it("rejects unknown kinds and missing statusId on status-bound kinds", () => {
    const accountId = AccountId.parse("acct-1");
    expect(accountId.isOk()).toBe(true);
    if (!accountId.isOk()) {
      return;
    }
    expect(
      Notification.parse({
        kind: "admin",
        id: "n1",
        accountId: accountId.value,
        createdAt: "2026-01-01T00:00:00.000Z",
      }).isErr(),
    ).toBe(true);
    expect(
      Notification.parse({
        kind: "favourite",
        id: "n1",
        accountId: accountId.value,
        createdAt: "2026-01-01T00:00:00.000Z",
      }).isErr(),
    ).toBe(true);
  });
});
