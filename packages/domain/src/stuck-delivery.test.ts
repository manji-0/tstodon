import { ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import { DELIVERY_GIVE_UP_AFTER_MS } from "./outbox-delivery";
import {
  type DeliveryInstanceState,
  StuckDelivery,
  type StuckDeliveryDeps,
  type StuckDeliveryTarget,
} from "./stuck-delivery";

const now = Date.parse("2026-11-09T12:00:00Z");

const target = (name: string, createdAt: string): StuckDeliveryTarget => ({
  activityId: name,
  inboxUrl: `https://${name}.example/inbox`,
  attemptCount: 2,
  createdAt,
});

const sweepWith = (
  targets: ReadonlyArray<StuckDeliveryTarget>,
  states: Readonly<Record<string, DeliveryInstanceState>>,
  started = true,
) => {
  const calls: string[] = [];
  let listedBefore = "";
  const deps: StuckDeliveryDeps = {
    list: async (dueBefore, limit) => {
      listedBefore = dueBefore;
      expect(limit).toBe(StuckDelivery.batch);
      return ok(targets);
    },
    instanceState: async (t) => states[t.activityId] ?? "Missing",
    create: async (t) => {
      calls.push(`create:${t.activityId}`);
      return started;
    },
    restart: async (t) => {
      calls.push(`restart:${t.activityId}`);
      return started;
    },
    postpone: async (t, at) => {
      calls.push(`postpone:${t.activityId}:${at}`);
      return ok(undefined);
    },
    giveUp: async (t) => {
      calls.push(`giveUp:${t.activityId}`);
      return ok(undefined);
    },
  };
  return { deps, calls, listedBefore: () => listedBefore };
};

describe("StuckDelivery", () => {
  it("looks at targets due over an hour ago", async () => {
    const { deps, listedBefore } = sweepWith([], {});
    expect((await StuckDelivery.sweep(deps, now))._unsafeUnwrap().examined).toBe(0);
    expect(listedBefore()).toBe("2026-11-09T11:00:00.000Z");
  });

  it("creates a missing Workflow, restarts an ended one, waits for an active one", async () => {
    const recent = "2026-11-09T09:00:00.000Z";
    const { deps, calls } = sweepWith(
      [target("never", recent), target("errored", recent), target("sleeping", recent)],
      { never: "Missing", errored: "Ended", sleeping: "Active" },
    );
    const swept = (await StuckDelivery.sweep(deps, now))._unsafeUnwrap();
    expect(swept).toEqual({
      examined: 3,
      created: 1,
      restarted: 1,
      waiting: 1,
      givenUp: 0,
      failed: 0,
    });
    const at = new Date(now).toISOString();
    expect(calls).toEqual([
      "create:never",
      `postpone:never:${at}`,
      "restart:errored",
      `postpone:errored:${at}`,
      `postpone:sleeping:${at}`,
    ]);
  });

  it("gives up a target older than any retry schedule", async () => {
    const old = new Date(now - DELIVERY_GIVE_UP_AFTER_MS - 1).toISOString();
    const { deps, calls } = sweepWith([target("ancient", old)], { ancient: "Ended" });
    expect((await StuckDelivery.sweep(deps, now))._unsafeUnwrap().givenUp).toBe(1);
    expect(calls).toEqual(["giveUp:ancient"]);
    expect(StuckDelivery.action(target("ancient", old), "Active", now)).toBe("GiveUp");
  });

  it("counts a failed start and postpones it behind the others", async () => {
    const { deps, calls } = sweepWith(
      [target("refused", "2026-11-09T09:00:00.000Z")],
      { refused: "Missing" },
      false,
    );
    expect((await StuckDelivery.sweep(deps, now))._unsafeUnwrap()).toMatchObject({
      created: 0,
      failed: 1,
    });
    expect(calls).toEqual(["create:refused", `postpone:refused:${new Date(now).toISOString()}`]);
  });
});
