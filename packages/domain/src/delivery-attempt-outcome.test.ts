import { describe, expect, it } from "vite-plus/test";
import { DeliveryAttemptOutcome } from "./delivery-attempt-outcome";

describe("DeliveryAttemptOutcome.forHttpStatus", () => {
  it("treats 2xx as Success", () => {
    expect(DeliveryAttemptOutcome.forHttpStatus(200)).toEqual(DeliveryAttemptOutcome.Success);
    expect(DeliveryAttemptOutcome.forHttpStatus(204)).toEqual(DeliveryAttemptOutcome.Success);
  });

  it("retries 401, 408, 429, 5xx (but 501) and odd statuses, as Mastodon", () => {
    for (const status of [0, 100, 301, 401, 408, 429, 500, 502, 503, 504]) {
      expect(DeliveryAttemptOutcome.forHttpStatus(status)).toEqual({
        kind: "TransientFailure",
        cause: { kind: "HttpStatus", httpStatus: status },
      });
    }
  });

  it("treats other 4xx and 501 as PermanentFailure with the status", () => {
    for (const status of [400, 403, 404, 410, 422, 501]) {
      expect(DeliveryAttemptOutcome.forHttpStatus(status)).toEqual({
        kind: "PermanentFailure",
        httpStatus: status,
      });
    }
  });

  it("keeps Retry-After only on 429 and 503", () => {
    expect(DeliveryAttemptOutcome.forHttpStatus(429, 120)).toEqual({
      kind: "TransientFailure",
      cause: { kind: "Throttled", httpStatus: 429, retryAfterSeconds: 120 },
    });
    expect(DeliveryAttemptOutcome.forHttpStatus(503, 0).kind).toBe("TransientFailure");
    expect(DeliveryAttemptOutcome.forHttpStatus(500, 120)).toEqual({
      kind: "TransientFailure",
      cause: { kind: "HttpStatus", httpStatus: 500 },
    });
    expect(DeliveryAttemptOutcome.forHttpStatus(404, 120).kind).toBe("PermanentFailure");
  });

  it("reads Retry-After as seconds or an HTTP-date", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    expect(DeliveryAttemptOutcome.retryAfterSeconds(null, now)).toBeUndefined();
    expect(DeliveryAttemptOutcome.retryAfterSeconds(" 90 ", now)).toBe(90);
    expect(DeliveryAttemptOutcome.retryAfterSeconds("Mon, 09 Nov 2026 13:00:00 GMT", now)).toBe(
      3600,
    );
    expect(DeliveryAttemptOutcome.retryAfterSeconds("Mon, 09 Nov 2026 11:00:00 GMT", now)).toBe(0);
    expect(DeliveryAttemptOutcome.retryAfterSeconds("soon", now)).toBeUndefined();
    expect(DeliveryAttemptOutcome.retryAfterSeconds("-5", now)).toBeUndefined();
  });

  it("says whether the remote answered", () => {
    expect(DeliveryAttemptOutcome.reachability(DeliveryAttemptOutcome.Success)).toBe("Reachable");
    expect(DeliveryAttemptOutcome.reachability(DeliveryAttemptOutcome.forHttpStatus(410))).toBe(
      "Reachable",
    );
    expect(DeliveryAttemptOutcome.reachability(DeliveryAttemptOutcome.forHttpStatus(502))).toBe(
      "Unreachable",
    );
    expect(DeliveryAttemptOutcome.reachability(DeliveryAttemptOutcome.forHttpStatus(429, 5))).toBe(
      "Unreachable",
    );
    expect(DeliveryAttemptOutcome.reachability(DeliveryAttemptOutcome.Network)).toBe("Unreachable");
    expect(DeliveryAttemptOutcome.reachability(DeliveryAttemptOutcome.Local)).toBe("Unknown");
  });

  it("labels outcomes for logs and metrics", () => {
    expect(DeliveryAttemptOutcome.label(DeliveryAttemptOutcome.Success)).toBe("success");
    expect(DeliveryAttemptOutcome.label(DeliveryAttemptOutcome.forHttpStatus(404))).toBe(
      "permanent",
    );
    expect(DeliveryAttemptOutcome.label(DeliveryAttemptOutcome.forHttpStatus(500))).toBe("http");
    expect(DeliveryAttemptOutcome.label(DeliveryAttemptOutcome.forHttpStatus(429, 1))).toBe(
      "throttled",
    );
    expect(DeliveryAttemptOutcome.label(DeliveryAttemptOutcome.Network)).toBe("network");
    expect(
      DeliveryAttemptOutcome.failedHttpStatus(DeliveryAttemptOutcome.forHttpStatus(429, 1)),
    ).toBe(429);
    expect(DeliveryAttemptOutcome.failedHttpStatus(DeliveryAttemptOutcome.Network)).toBe(0);
  });

  it("parses outcomes through the companion schema", () => {
    const parsed = DeliveryAttemptOutcome.parse({ kind: "PermanentFailure", httpStatus: 422 });
    expect(parsed.isOk()).toBe(true);
    const invalid = DeliveryAttemptOutcome.parse({ kind: "PermanentFailure", httpStatus: 399 });
    expect(invalid.isErr()).toBe(true);
    expect(DeliveryAttemptOutcome.parse({ kind: "TransientFailure" }).isErr()).toBe(true);
    expect(DeliveryAttemptOutcome.parse(DeliveryAttemptOutcome.Network).isOk()).toBe(true);
  });
});
