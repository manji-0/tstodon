import { ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import {
  DELIVERY_FAILURE_DAYS_THRESHOLD,
  DeliveryDomainHealth,
  type DeliveryDomainHealthDeps,
} from "./delivery-domain-health";
import { Hostname } from "./hostname";

const DAY = 24 * 60 * 60 * 1000;
const start = Date.parse("2026-11-01T10:00:00Z");
const domain = Hostname.ofAuthority("down.example");

/** An in-memory store with a cache that can lag behind it. */
const memoryStore = () => {
  const rows = new Map<string, DeliveryDomainHealth>();
  const writes: string[] = [];
  const deps: DeliveryDomainHealthDeps = {
    cached: async (key) => rows.get(key),
    find: async (key) => ok(rows.get(key)),
    save: async (health) => {
      writes.push(`save:${health.kind}:${health.failureDays}`);
      rows.set(health.domain, health);
      return ok(undefined);
    },
    clear: async (key) => {
      writes.push("clear");
      rows.delete(key);
      return ok(undefined);
    },
  };
  return { rows, writes, deps };
};

const record = async (
  deps: DeliveryDomainHealthDeps,
  reachability: "Reachable" | "Unreachable" | "Unknown",
  at: number,
) => (await DeliveryDomainHealth.record(deps, domain, reachability, at))._unsafeUnwrap();

describe("DeliveryDomainHealth", () => {
  it("counts distinct UTC days, not failures", async () => {
    const { deps, rows, writes } = memoryStore();
    expect(await record(deps, "Unreachable", start)).toEqual({
      kind: "FailureDayRecorded",
      failureDays: 1,
    });
    // Later the same day: nothing to write.
    expect(await record(deps, "Unreachable", start + 3 * 60 * 60 * 1000)).toEqual({
      kind: "Unchanged",
    });
    expect(await record(deps, "Unreachable", start + DAY)).toEqual({
      kind: "FailureDayRecorded",
      failureDays: 2,
    });
    expect(writes).toEqual(["save:Failing:1", "save:Failing:2"]);
    expect(rows.get(domain)).toEqual({
      kind: "Failing",
      domain,
      failureDays: 2,
      lastFailureDay: "2026-11-02",
    });
  });

  it("marks the domain unavailable on the seventh failure day", async () => {
    const { deps, rows } = memoryStore();
    expect(DELIVERY_FAILURE_DAYS_THRESHOLD).toBe(7);
    for (let day = 0; day < 6; day += 1) {
      expect((await record(deps, "Unreachable", start + day * DAY)).kind).toBe(
        "FailureDayRecorded",
      );
    }
    expect(DeliveryDomainHealth.isUnavailable(rows.get(domain))).toBe(false);
    // Days need not be consecutive.
    const seventh = start + 9 * DAY;
    expect(await record(deps, "Unreachable", seventh)).toEqual({
      kind: "BecameUnavailable",
      failureDays: 7,
    });
    expect(rows.get(domain)).toEqual({
      kind: "Unavailable",
      domain,
      failureDays: 7,
      lastFailureDay: "2026-11-10",
      unavailableSince: new Date(seventh).toISOString(),
    });
    expect(DeliveryDomainHealth.isUnavailable(rows.get(domain))).toBe(true);
    // A later failure only adds a day.
    expect(await record(deps, "Unreachable", seventh + DAY)).toEqual({
      kind: "FailureDayRecorded",
      failureDays: 8,
    });
    expect(rows.get(domain)?.kind).toBe("Unavailable");
  });

  it("is cleared by a reachable answer, at no cost when nothing is recorded", async () => {
    const { deps, rows, writes } = memoryStore();
    expect(await record(deps, "Reachable", start)).toEqual({ kind: "Unchanged" });
    expect(writes).toEqual([]);
    for (let day = 0; day < 7; day += 1) {
      await record(deps, "Unreachable", start + day * DAY);
    }
    expect(await record(deps, "Reachable", start + 8 * DAY)).toEqual({
      kind: "Cleared",
      wasUnavailable: true,
      failureDays: 7,
    });
    expect(rows.has(domain)).toBe(false);
    // Counting starts over.
    expect(await record(deps, "Unreachable", start + 9 * DAY)).toEqual({
      kind: "FailureDayRecorded",
      failureDays: 1,
    });
  });

  it("ignores attempts that say nothing about the remote", async () => {
    const { deps, writes } = memoryStore();
    expect(await record(deps, "Unknown", start)).toEqual({ kind: "Unchanged" });
    expect(writes).toEqual([]);
  });

  it("reads the stored record when the cache is stale", async () => {
    const { deps, rows } = memoryStore();
    await record(deps, "Unreachable", start);
    await record(deps, "Unreachable", start + DAY);
    const stale: DeliveryDomainHealthDeps = { ...deps, cached: async () => undefined };
    expect(await record(stale, "Unreachable", start + 2 * DAY)).toEqual({
      kind: "FailureDayRecorded",
      failureDays: 3,
    });
    expect(rows.get(domain)?.failureDays).toBe(3);
  });

  it("parses stored records", () => {
    expect(
      DeliveryDomainHealth.parse({
        kind: "Failing",
        domain: "a.example",
        failureDays: 2,
        lastFailureDay: "2026-11-01",
      }).isOk(),
    ).toBe(true);
    expect(
      DeliveryDomainHealth.parse({
        kind: "Unavailable",
        domain: "a.example",
        failureDays: 7,
        lastFailureDay: "2026-11-01",
      }).isErr(),
    ).toBe(true);
    expect(DeliveryDomainHealth.dayOf(Date.parse("2026-11-01T23:59:59Z"))).toBe("2026-11-01");
  });
});
