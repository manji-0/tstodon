import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Activity } from "./activity";
import { InboxActivity } from "./inbox-activity";

describe("Activity", () => {
  it("parses a nested relationship activity through the composed union", () => {
    const parsed = Activity.parse({
      kind: "Follow",
      id: "https://example.com/activities/1",
      actor: "https://example.com/users/alice",
      object: "https://example.com/users/bob",
    });
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.kind).toBe("Follow");
    }
  });

  it("exposes a single option via z.getDiscriminatedOption", () => {
    const follow = z.getDiscriminatedOption(Activity.schema, "Follow");
    const parsed = follow.parse({
      kind: "Follow",
      id: "https://example.com/activities/1",
      actor: "https://example.com/users/alice",
      object: "https://example.com/users/bob",
    });
    expect(parsed.kind).toBe("Follow");
  });

  it("dispatches inbox payloads and duplicates by activity id", () => {
    const payload = {
      kind: "Create",
      id: "https://example.com/activities/2",
      actor: "https://example.com/users/alice",
      object: "https://example.com/users/alice/statuses/1",
    };
    const received = {
      kind: "Received" as const,
      activityId: payload.id,
      payload,
    };
    const dispatched = InboxActivity.dispatch(received, new Set());
    expect(dispatched.kind).toBe("Dispatched");
    const duplicate = InboxActivity.dispatch(received, new Set([payload.id]));
    expect(duplicate.kind).toBe("Duplicate");
  });
});
