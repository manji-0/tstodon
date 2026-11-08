import { describe, expect, it } from "vite-plus/test";
import { QuoteRetry } from "./quote-retry";

describe("QuoteRetry", () => {
  it("waits 30 to 600 seconds before the first refetch", () => {
    expect(QuoteRetry.refetchDelaySeconds(1, 0)).toBe(30);
    expect(QuoteRetry.refetchDelaySeconds(1, 0.999999)).toBe(600);
  });

  it("backs off as Sidekiq's ExponentialBackoff after that", () => {
    expect(QuoteRetry.refetchDelaySeconds(2, 0.5)).toBe(15);
    expect(QuoteRetry.refetchDelaySeconds(3, 0)).toBe(25);
    expect(QuoteRetry.refetchDelaySeconds(3, 0.999999)).toBe(34);
    expect(QuoteRetry.refetchDelaySeconds(4, 0)).toBe(175);
    expect(QuoteRetry.refetchDelaySeconds(4, 0.999999)).toBe(334);
  });

  it("stops after four attempts", () => {
    expect([1, 2, 3, 4].map(QuoteRetry.nextRefetchAttempt)).toEqual([2, 3, 4, undefined]);
  });

  it("spreads a refresh over six hours", () => {
    expect(QuoteRetry.refreshDelaySeconds(0)).toBe(0);
    expect(QuoteRetry.refreshDelaySeconds(0.999999)).toBe(21599);
  });
});
