import { describe, expect, it } from "vitest";
import { DeliveryAttemptOutcome } from "./delivery-attempt-outcome";

describe("DeliveryAttemptOutcome.forHttpStatus", () => {
  it("treats 2xx as Success", () => {
    expect(DeliveryAttemptOutcome.forHttpStatus(200)).toEqual(DeliveryAttemptOutcome.Success);
    expect(DeliveryAttemptOutcome.forHttpStatus(204)).toEqual(DeliveryAttemptOutcome.Success);
  });

  it("treats timeouts, rate limits, and 5xx as TransientFailure", () => {
    for (const status of [0, 100, 408, 429, 500, 503]) {
      expect(DeliveryAttemptOutcome.forHttpStatus(status)).toEqual(
        DeliveryAttemptOutcome.TransientFailure,
      );
    }
  });

  it("treats other 4xx as PermanentFailure with the status", () => {
    expect(DeliveryAttemptOutcome.forHttpStatus(404)).toEqual({
      kind: "PermanentFailure",
      httpStatus: 404,
    });
    expect(DeliveryAttemptOutcome.forHttpStatus(410)).toEqual({
      kind: "PermanentFailure",
      httpStatus: 410,
    });
  });

  it("parses PermanentFailure through the companion schema", () => {
    const parsed = DeliveryAttemptOutcome.parse({ kind: "PermanentFailure", httpStatus: 422 });
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.kind).toBe("PermanentFailure");
    }
    const invalid = DeliveryAttemptOutcome.parse({ kind: "PermanentFailure", httpStatus: 399 });
    expect(invalid.isErr()).toBe(true);
  });
});
