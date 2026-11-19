import { describe, expect, it } from "vite-plus/test";
import { PendingStatusFederation } from "./pending-status-federation";

describe("PendingStatusFederation.afterFailure", () => {
  it("backs off as Sidekiq's ExponentialBackoff, at most twelve hours", () => {
    expect([1, 2, 3, 7, 8, 11].map(PendingStatusFederation.afterFailure)).toEqual([
      { kind: "Retry", delaySeconds: 25 },
      { kind: "Retry", delaySeconds: 175 },
      { kind: "Retry", delaySeconds: 825 },
      { kind: "Retry", delaySeconds: 24025 },
      { kind: "Retry", delaySeconds: 40975 },
      { kind: "Retry", delaySeconds: 43200 },
    ]);
  });

  it("gives up once twelve tries failed", () => {
    expect(PendingStatusFederation.afterFailure(12)).toEqual({ kind: "GiveUp" });
  });
});
