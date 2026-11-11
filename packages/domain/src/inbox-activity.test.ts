import { describe, expect, it } from "vite-plus/test";
import { ActivityId } from "./activity-id";
import { InboxActivity, InboxClaim } from "./inbox-activity";

describe("InboxActivity.dispatch", () => {
  it("rejects unparsable payloads as UnknownType", () => {
    const activityId = ActivityId.parse("https://example.com/activities/bad");
    if (activityId.isErr()) {
      throw new Error("activity id rejected");
    }
    const received = {
      kind: "Received" as const,
      activityId: activityId.value,
      payload: { kind: "NotAnActivity" },
    };
    const rejected = InboxActivity.dispatch(received, { kind: "Acquired" });
    expect(rejected).toEqual({
      kind: "Rejected",
      activityId: received.activityId,
      error: { kind: "UnknownType", type: "unparsed" },
    });
  });

  it("parses Rejected and UnknownType variants via schema", () => {
    const parsed = InboxActivity.parse({
      kind: "Rejected",
      activityId: "https://example.com/activities/1",
      error: { kind: "InvalidSignature" },
    });
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.kind).toBe("Rejected");
      if (parsed.value.kind === "Rejected") {
        expect(parsed.value.error.kind).toBe("InvalidSignature");
      }
    }
    const unknownType = InboxActivity.parse({
      kind: "Rejected",
      activityId: "https://example.com/activities/2",
      error: { kind: "UnknownType", type: "EmojiReact" },
    });
    expect(unknownType.isOk()).toBe(true);
  });

  it("answers a claim another delivery holds as a Duplicate, without parsing", () => {
    const activityId = ActivityId.parse("https://example.com/activities/held");
    if (activityId.isErr()) {
      throw new Error("activity id rejected");
    }
    const received = {
      kind: "Received" as const,
      activityId: activityId.value,
      payload: { kind: "NotAnActivity" },
    };
    for (const claim of [{ kind: "InFlight" }, { kind: "Processed" }] as const) {
      expect(InboxActivity.dispatch(received, claim)).toEqual({
        kind: "Duplicate",
        activityId: received.activityId,
        claim,
      });
    }
  });
});

describe("InboxClaim.staleBefore", () => {
  it("is 15 minutes before now", () => {
    expect(InboxClaim.staleBefore(Date.parse("2026-11-11T12:00:00.000Z"))).toBe(
      "2026-11-11T11:45:00.000Z",
    );
  });
});
