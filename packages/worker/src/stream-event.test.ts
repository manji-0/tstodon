import { describe, expect, it } from "vitest";
import { StreamEvent } from "@tstodon/domain";

describe("stream events", () => {
  it("accepts the notifications_merged event", () => {
    const parsed = StreamEvent.parse({ kind: "notifications_merged" });
    expect(parsed.isOk()).toBe(true);
    // Unknown kinds still fail closed.
    expect(StreamEvent.parse({ kind: "nope" }).isErr()).toBe(true);
  });
});
