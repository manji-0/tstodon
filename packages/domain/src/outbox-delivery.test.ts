import { describe, expect, it } from "vitest";
import { DeliveryAttemptOutcome } from "./delivery-attempt-outcome";
import { DELIVERY_MAX_ATTEMPTS, OutboxDelivery } from "./outbox-delivery";

describe("OutboxDelivery", () => {
  it("retries transient failures until the attempt ceiling", () => {
    let slot = OutboxDelivery.queued();
    for (let i = 0; i < DELIVERY_MAX_ATTEMPTS - 1; i += 1) {
      const next = OutboxDelivery.afterAttempt(slot, DeliveryAttemptOutcome.TransientFailure);
      expect(next.kind).toBe("Queued");
      if (next.kind === "Queued") {
        slot = next;
      }
    }
    const failed = OutboxDelivery.afterAttempt(slot, DeliveryAttemptOutcome.TransientFailure);
    expect(failed).toMatchObject({
      kind: "Failed",
      reasonKind: "RetryExhausted",
    });
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

  it("marks an empty fan-out as Delivered", () => {
    expect(OutboxDelivery.afterExpand(0).kind).toBe("Delivered");
    expect(OutboxDelivery.afterExpand(2).kind).toBe("Expanded");
  });

  it("maps retry delays onto Workflow sleep labels", () => {
    expect(OutboxDelivery.workflowSleep(1)).toBe("1 minute");
    expect(OutboxDelivery.workflowSleep(2)).toBe("5 minutes");
    expect(OutboxDelivery.workflowSleep(4)).toBe("60 minutes");
  });
});
