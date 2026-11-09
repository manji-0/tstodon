import { describe, expect, it } from "vite-plus/test";
import { DeliveryAttemptOutcome } from "./delivery-attempt-outcome";
import {
  DELIVERY_MAX_ATTEMPTS,
  OutboxDelivery,
  RETRY_AFTER_CAP_SECONDS,
  type QueuedOutboxDelivery,
} from "./outbox-delivery";

const transient = DeliveryAttemptOutcome.forHttpStatus(503);

describe("OutboxDelivery", () => {
  it("retries transient failures until the attempt ceiling", () => {
    let slot: QueuedOutboxDelivery = OutboxDelivery.queued();
    for (let i = 0; i < DELIVERY_MAX_ATTEMPTS - 1; i += 1) {
      const next = OutboxDelivery.afterAttempt(slot, transient);
      expect(next.kind).toBe("Queued");
      if (next.kind === "Queued") {
        slot = next;
      }
    }
    expect(slot.attemptCount).toBe(16);
    const failed = OutboxDelivery.afterAttempt(slot, DeliveryAttemptOutcome.Network);
    expect(failed).toEqual({ kind: "Failed", reasonKind: "RetryExhausted", attemptCount: 17 });
  });

  it("makes 17 attempts: one and Mastodon's 16 retries", () => {
    expect(DELIVERY_MAX_ATTEMPTS).toBe(17);
  });

  it("treats 404 as a nested permanent failure", () => {
    const failed = OutboxDelivery.afterAttempt(
      OutboxDelivery.queued(),
      DeliveryAttemptOutcome.forHttpStatus(404),
    );
    expect(failed).toEqual({
      kind: "Failed",
      reasonKind: "Permanent",
      httpStatus: 404,
    } as const satisfies typeof failed);
  });

  it("leaves settled and skipped targets alone", () => {
    const skipped = OutboxDelivery.skipped();
    expect(skipped).toEqual({ kind: "Skipped", reasonKind: "DomainUnavailable" });
    expect(OutboxDelivery.afterAttempt(skipped, DeliveryAttemptOutcome.Success)).toEqual(skipped);
    expect(OutboxDelivery.parse(skipped).isOk()).toBe(true);
    expect(OutboxDelivery.parse({ kind: "Skipped", reasonKind: "Other" }).isErr()).toBe(true);
  });

  it("marks an empty fan-out as Delivered", () => {
    expect(OutboxDelivery.afterExpand(0).kind).toBe("Delivered");
    expect(OutboxDelivery.afterExpand(2).kind).toBe("Expanded");
  });
});

describe("OutboxDelivery backoff", () => {
  it("is Sidekiq's count⁴ + 15 + rand(10) × (count + 1) seconds", () => {
    expect(OutboxDelivery.backoffMs(0, 0)).toBe(15_000);
    expect(OutboxDelivery.backoffMs(0, 0.99)).toBe(24_000);
    expect(OutboxDelivery.backoffMs(1, 0)).toBe(16_000);
    expect(OutboxDelivery.backoffMs(3, 0.5)).toBe((81 + 15 + 5 * 4) * 1000);
    expect(OutboxDelivery.backoffMs(15, 0)).toBe((50_625 + 15) * 1000);
    // rand(10) is at most 9 even for a random of 1.
    expect(OutboxDelivery.backoffMs(2, 1)).toBe((16 + 15 + 9 * 3) * 1000);
  });

  it("grows with each retry and spans about two days over the 16 retries", () => {
    let slot: QueuedOutboxDelivery = OutboxDelivery.queued();
    const delays: number[] = [];
    for (let i = 0; i < DELIVERY_MAX_ATTEMPTS - 1; i += 1) {
      const next = OutboxDelivery.afterAttempt(slot, transient);
      if (next.kind !== "Queued") {
        throw new Error("settled early");
      }
      delays.push(OutboxDelivery.nextDelayMs(next, transient, 0));
      slot = next;
    }
    expect(delays).toHaveLength(16);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1] ?? 0);
    }
    const hours = (ms: number) => ms / 3_600_000;
    const least = delays.reduce((sum, delay) => sum + delay, 0);
    expect(hours(least)).toBeGreaterThan(49);
    expect(hours(least)).toBeLessThan(50);
    let most = 0;
    for (let count = 0; count < 16; count += 1) {
      most += OutboxDelivery.backoffMs(count, 0.999);
    }
    expect(hours(most)).toBeLessThan(50 + 1224 / 3600 + 0.01);
    // The longest single sleep is about 14 hours.
    expect(hours(delays[15] ?? 0)).toBeCloseTo(14.07, 1);
  });

  it("waits for a longer Retry-After on 429 and 503, capped", () => {
    const next: QueuedOutboxDelivery = { kind: "Queued", attemptCount: 1 };
    const throttled = DeliveryAttemptOutcome.forHttpStatus(429, 3600);
    expect(OutboxDelivery.nextDelayMs(next, throttled, 0)).toBe(3_600_000);
    // A Retry-After shorter than the backoff does not shorten it.
    const soon = DeliveryAttemptOutcome.forHttpStatus(503, 1);
    expect(OutboxDelivery.nextDelayMs(next, soon, 0)).toBe(15_000);
    const forever = DeliveryAttemptOutcome.forHttpStatus(429, 10 * 24 * 3600);
    expect(OutboxDelivery.nextDelayMs(next, forever, 0)).toBe(RETRY_AFTER_CAP_SECONDS * 1000);
    // A 500 with Retry-After is an ordinary failure.
    const plain = DeliveryAttemptOutcome.forHttpStatus(500, 3600);
    expect(OutboxDelivery.nextDelayMs(next, plain, 0)).toBe(15_000);
  });
});
