import { describe, expect, it } from "vite-plus/test";
import {
  annualReportArchetype,
  annualReportCampaign,
  annualReportRefresh,
  annualReportYearRange,
} from "./annual-report";

describe("annualReportCampaign", () => {
  it("offers the year from December 10 to 31 (UTC)", () => {
    expect(annualReportCampaign(new Date("2025-12-10T00:00:00Z"))).toBe(2025);
    expect(annualReportCampaign(new Date("2025-12-31T23:59:59Z"))).toBe(2025);
  });

  it("offers nothing the rest of the year", () => {
    expect(annualReportCampaign(new Date("2025-12-09T23:59:59Z"))).toBeUndefined();
    expect(annualReportCampaign(new Date("2026-01-01T00:00:00Z"))).toBeUndefined();
    expect(annualReportCampaign(new Date("2025-11-20T00:00:00Z"))).toBeUndefined();
  });
});

describe("annualReportYearRange", () => {
  it("bounds stored instants of either form", () => {
    const { start, end } = annualReportYearRange(2025);
    for (const inside of [
      "2025-01-01T00:00:00.000Z",
      "2025-01-01 00:00:00",
      "2025-12-31T23:59:59Z",
    ]) {
      expect(inside >= start && inside < end, inside).toBe(true);
    }
    for (const outside of ["2024-12-31T23:59:59Z", "2026-01-01 00:00:00", "2026-01-01T00:00:00Z"]) {
      expect(outside >= start && outside < end, outside).toBe(false);
    }
  });
});

describe("annualReportArchetype", () => {
  const counts = { standalone: 100, replies: 0, reblogs: 0, polls: 0 };

  it("is a lurker under 113 posts, replies and boosts", () => {
    expect(annualReportArchetype({ ...counts, standalone: 112 })).toBe("lurker");
    expect(annualReportArchetype({ ...counts, standalone: 113 })).toBe("oracle");
  });

  it("is a booster past twice as many boosts as posts", () => {
    expect(annualReportArchetype({ ...counts, standalone: 40, reblogs: 81 })).toBe("booster");
    expect(annualReportArchetype({ ...counts, standalone: 40, reblogs: 80 })).toBe("oracle");
  });

  it("is a pollster past one poll in ten posts", () => {
    expect(annualReportArchetype({ ...counts, standalone: 120, polls: 13 })).toBe("pollster");
    expect(annualReportArchetype({ ...counts, standalone: 120, polls: 12 })).toBe("oracle");
  });

  it("is a replier past twice as many replies as posts", () => {
    expect(annualReportArchetype({ ...counts, standalone: 40, replies: 81 })).toBe("replier");
  });

  it("checks boosts before polls and polls before replies", () => {
    expect(annualReportArchetype({ standalone: 50, replies: 200, reblogs: 101, polls: 50 })).toBe(
      "booster",
    );
    expect(annualReportArchetype({ standalone: 50, replies: 200, reblogs: 0, polls: 50 })).toBe(
      "pollster",
    );
  });
});

describe("annualReportRefresh", () => {
  const startedAt = new Date("2025-12-12T00:00:00Z");
  const at = (offsetMs: number) => new Date(startedAt.getTime() + offsetMs);
  const hour = 60 * 60 * 1000;

  it("runs until the job finishes, for at most a day", () => {
    const running = { startedAt, finishedAt: undefined };
    expect(annualReportRefresh(running, at(23 * hour))).toEqual({ kind: "Running" });
    expect(annualReportRefresh(running, at(24 * hour))).toBeUndefined();
  });

  it("reads finished for an hour after the job", () => {
    const finished = { startedAt, finishedAt: at(hour) };
    expect(annualReportRefresh(finished, at(hour + 59 * 60 * 1000))).toEqual({ kind: "Finished" });
    expect(annualReportRefresh(finished, at(2 * hour))).toBeUndefined();
  });
});
