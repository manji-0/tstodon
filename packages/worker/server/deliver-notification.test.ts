import type {
  NewNotification,
  NotificationPolicyAction,
  PreviousGroupBucket,
  SenderScreening,
} from "@tstodon/domain";
import { ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import { deliverNotification } from "./notify";

const mention = {
  accountId: "100",
  fromAccountId: "200",
  kind: "mention",
  statusId: "300",
} as const satisfies NewNotification;

const favouriteOf300 = {
  accountId: "100",
  fromAccountId: "200",
  kind: "favourite",
  statusId: "300",
} as const satisfies NewNotification;

/** Hour bucket 493,000 starts at 2026-03-29T16:00:00Z. */
const NOW = "2026-03-29T17:30:00.000Z";

const recording = (
  disposition: NotificationPolicyAction,
  muted: ReadonlyArray<string> = [],
  screening: SenderScreening = { kind: "Screen" },
  previous: PreviousGroupBucket | undefined = undefined,
) => {
  const events: string[] = [];
  return {
    events,
    contracts: {
      now: () => NOW,
      findGroupBucket: async (accountId: string, typePrefix: string) => {
        events.push(`bucket ${accountId} ${typePrefix}`);
        return ok(previous);
      },
      screenSender: async () => ok(screening),
      resolveDisposition: async () => {
        events.push("disposition");
        return ok(disposition);
      },
      findMutedThreadStatusIds: async (_accountId: string, statusIds: ReadonlyArray<string>) =>
        ok(new Set(statusIds.filter((id) => muted.includes(id)))),
      insertNotification: async (notification: NewNotification, groupKey?: string) => {
        events.push(`insert ${notification.kind}${groupKey === undefined ? "" : ` ${groupKey}`}`);
        return ok("n1");
      },
      holdNotification: async (notificationId: string) => {
        events.push(`hold ${notificationId}`);
        return ok(undefined);
      },
      keepOutOfConversations: async (notification: NewNotification) => {
        events.push(`keep out ${notification.statusId ?? ""}`);
        return ok(undefined);
      },
      publishNotification: async (accountId: string, notificationId: string) => {
        events.push(`publish ${accountId} ${notificationId}`);
      },
    },
  };
};

describe("deliverNotification", () => {
  it("records and publishes a notification the policy accepts", async () => {
    const store = recording("accept");
    expect((await deliverNotification(store.contracts, mention)).isOk()).toBe(true);
    expect(store.events).toEqual(["disposition", "insert mention", "publish 100 n1"]);
  });

  it("holds a filtered notification as a request without publishing it", async () => {
    const store = recording("filter");
    await deliverNotification(store.contracts, mention);
    expect(store.events).toEqual(["disposition", "insert mention", "hold n1"]);
  });

  it.each(["accept", "filter"] as const)(
    "neither holds nor publishes a notification that was already recorded (%s)",
    async (disposition) => {
      const store = recording(disposition);
      const contracts = { ...store.contracts, insertNotification: async () => ok(undefined) };
      expect((await deliverNotification(contracts, mention)).isOk()).toBe(true);
      expect(store.events).toEqual(["disposition"]);
    },
  );

  it("records nothing the policy drops, and keeps a dropped mention out of conversations", async () => {
    const store = recording("drop");
    await deliverNotification(store.contracts, mention);
    expect(store.events).toEqual(["disposition", "keep out 300"]);
  });

  it("records nothing about a status in a muted conversation", async () => {
    const store = recording("accept", ["300"]);
    await deliverNotification(store.contracts, mention);
    expect(store.events).toEqual(["disposition", "keep out 300"]);
  });

  it("delivers moderation notifications past a dropping policy", async () => {
    const store = recording("drop");
    await deliverNotification(store.contracts, {
      accountId: "100",
      fromAccountId: "200",
      kind: "admin.sign_up",
    });
    expect(store.events).toEqual([
      "bucket 100 admin.sign_up",
      "insert admin.sign_up admin.sign_up-493001",
      "publish 100 n1",
    ]);
  });

  it("records a groupable notification under its type prefix and hour bucket", async () => {
    const store = recording("accept");
    await deliverNotification(store.contracts, favouriteOf300);
    expect(store.events).toEqual([
      "disposition",
      "bucket 100 favourite-300",
      "insert favourite favourite-300-493001",
      "publish 100 n1",
    ]);
  });

  it("records a groupable notification in its type prefix's live bucket", async () => {
    const store = recording(
      "accept",
      [],
      { kind: "Screen" },
      {
        bucket: 492_995,
        setAt: "2026-03-29T12:00:00.000Z",
      },
    );
    await deliverNotification(store.contracts, { ...favouriteOf300, kind: "follow" });
    expect(store.events).toContain("insert follow follow-492995");
  });

  it("gives a held notification no group key, as Mastodon's filtered ones", async () => {
    const store = recording("filter");
    await deliverNotification(store.contracts, favouriteOf300);
    expect(store.events).toEqual(["disposition", "insert favourite", "hold n1"]);
  });

  it("records nothing of any kind from a sender screened out", async () => {
    for (const kind of ["mention", "status", "quoted_update", "admin.sign_up"]) {
      const store = recording("accept", [], { kind: "Drop" });
      await deliverNotification(store.contracts, { ...mention, kind });
      expect(store.events).toEqual([]);
    }
  });

  it("delivers a bypassing sender's notification past a dropping policy and a muted conversation", async () => {
    const store = recording("drop", ["300"], { kind: "Bypass" });
    await deliverNotification(store.contracts, mention);
    expect(store.events).toEqual(["insert mention", "publish 100 n1"]);
  });
});
