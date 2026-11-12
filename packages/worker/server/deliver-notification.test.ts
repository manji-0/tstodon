import type { NewNotification, NotificationPolicyAction, SenderScreening } from "@tstodon/domain";
import { ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import { deliverNotification } from "./notify";

const mention = {
  accountId: "100",
  fromAccountId: "200",
  kind: "mention",
  statusId: "300",
} as const satisfies NewNotification;

const recording = (
  disposition: NotificationPolicyAction,
  muted: ReadonlyArray<string> = [],
  screening: SenderScreening = { kind: "Screen" },
) => {
  const events: string[] = [];
  return {
    events,
    contracts: {
      screenSender: async () => ok(screening),
      resolveDisposition: async () => {
        events.push("disposition");
        return ok(disposition);
      },
      findMutedThreadStatusIds: async (_accountId: string, statusIds: ReadonlyArray<string>) =>
        ok(new Set(statusIds.filter((id) => muted.includes(id)))),
      insertNotification: async (notification: NewNotification) => {
        events.push(`insert ${notification.kind}`);
        return ok("n1");
      },
      holdNotification: async (notificationId: string) => {
        events.push(`hold ${notificationId}`);
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

  it("records nothing the policy drops", async () => {
    const store = recording("drop");
    await deliverNotification(store.contracts, mention);
    expect(store.events).toEqual(["disposition"]);
  });

  it("records nothing about a status in a muted conversation", async () => {
    const store = recording("accept", ["300"]);
    await deliverNotification(store.contracts, mention);
    expect(store.events).toEqual(["disposition"]);
  });

  it("delivers moderation notifications past a dropping policy", async () => {
    const store = recording("drop");
    await deliverNotification(store.contracts, {
      accountId: "100",
      fromAccountId: "200",
      kind: "admin.sign_up",
    });
    expect(store.events).toEqual(["insert admin.sign_up", "publish 100 n1"]);
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
