import { err, ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import { ActivityVacuum } from "./activity-vacuum";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");

describe("ActivityVacuum.retention", () => {
  it("defaults each table to 30 days", () => {
    expect(ActivityVacuum.retention({})).toEqual({
      deliveries: { kind: "Days", days: 30 },
      outbound: { kind: "Days", days: 30 },
      inbox: { kind: "Days", days: 30 },
    });
  });

  it("reads days, turns a table off, and ignores what is not a number", () => {
    expect(ActivityVacuum.retention({ deliveries: " 3 ", outbound: "off", inbox: "lots" })).toEqual(
      {
        deliveries: { kind: "Days", days: 3 },
        outbound: { kind: "Off" },
        inbox: { kind: "Days", days: 30 },
      },
    );
    expect(ActivityVacuum.retention({ deliveries: "0" }).deliveries).toEqual({ kind: "Off" });
  });

  it("keeps inbox activities long enough to dedupe a redelivery", () => {
    expect(ActivityVacuum.retention({ inbox: "1" }).inbox).toEqual({
      kind: "Days",
      days: ActivityVacuum.minInboxDays,
    });
  });
});

describe("ActivityVacuum.pass", () => {
  const retention = ActivityVacuum.retention({ deliveries: "30", outbound: "60", inbox: "7" });

  it("prunes each table before its own cutoff, in order", async () => {
    const calls: string[] = [];
    const pass = await ActivityVacuum.pass(
      {
        pruneDeliveries: async (before, limit) => {
          calls.push(`deliveries ${before} ${limit}`);
          return ok(2);
        },
        pruneOutbound: async (before, keep, limit) => {
          calls.push(`outbound ${before} ${keep} ${limit}`);
          return ok(1);
        },
        pruneInbox: async (before, limit) => {
          calls.push(`inbox ${before} ${limit}`);
          return ok(0);
        },
      },
      retention,
      NOW,
    );
    expect(pass._unsafeUnwrap()).toEqual({ deliveries: 2, outbound: 1, inbox: 0, chained: false });
    expect(calls).toEqual([
      `deliveries 2026-10-10T12:00:00.000Z ${ActivityVacuum.batch}`,
      `outbound 2026-09-10T12:00:00.000Z ${ActivityVacuum.keepOutboxItems} ${ActivityVacuum.batch}`,
      `inbox 2026-11-02T12:00:00.000Z ${ActivityVacuum.batch}`,
    ]);
  });

  it("chains when any table filled its batch", async () => {
    const pass = await ActivityVacuum.pass(
      {
        pruneDeliveries: async () => ok(0),
        pruneOutbound: async () => ok(0),
        pruneInbox: async (_before, limit) => ok(limit),
      },
      retention,
      NOW,
    );
    expect(pass._unsafeUnwrap().chained).toBe(true);
  });

  it("does not query a table whose pruning is off", async () => {
    const calls: string[] = [];
    const pass = await ActivityVacuum.pass(
      {
        pruneDeliveries: async () => {
          calls.push("deliveries");
          return ok(0);
        },
        pruneOutbound: async () => {
          calls.push("outbound");
          return ok(0);
        },
        pruneInbox: async () => {
          calls.push("inbox");
          return ok(0);
        },
      },
      ActivityVacuum.retention({ deliveries: "off", outbound: "off", inbox: "off" }),
      NOW,
    );
    expect(pass._unsafeUnwrap()).toEqual({ deliveries: 0, outbound: 0, inbox: 0, chained: false });
    expect(calls).toEqual([]);
  });

  it("stops at the first table that fails", async () => {
    let inboxCalled = false;
    const pass = await ActivityVacuum.pass(
      {
        pruneDeliveries: async () => ok(0),
        pruneOutbound: async () => err({ kind: "RepositoryError", message: "busy" } as const),
        pruneInbox: async () => {
          inboxCalled = true;
          return ok(0);
        },
      },
      retention,
      NOW,
    );
    expect(pass.isErr()).toBe(true);
    expect(inboxCalled).toBe(false);
  });
});
