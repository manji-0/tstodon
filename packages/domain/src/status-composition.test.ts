import { describe, expect, it } from "vitest";
import { StatusComposition } from "./status-composition";
import { StatusId } from "./status-id";
import { StatusQuoteTarget } from "./status-quote-target";
import { Visibility } from "./visibility";

describe("StatusComposition", () => {
  it("validates a text-only public note", () => {
    const composing = StatusComposition.composing({
      text: " hello ",
      visibility: Visibility.Public,
    });
    const validated = StatusComposition.validate(composing);
    expect(validated.isOk()).toBe(true);
    if (validated.isOk()) {
      expect(validated.value.kind).toBe("Validated");
      expect(validated.value.text).toBe("hello");
    }
  });

  it("rejects an empty payload", () => {
    const composing = StatusComposition.composing({
      text: "   ",
      visibility: Visibility.Public,
    });
    const validated = StatusComposition.validate(composing);
    expect(validated.isErr()).toBe(true);
    if (validated.isErr()) {
      expect(validated.error.kind).toBe("EmptyPayload");
    }
  });

  it("rejects a quote with media", () => {
    const statusId = StatusId.parse("status-1");
    expect(statusId.isOk()).toBe(true);
    if (!statusId.isOk()) {
      return;
    }
    const composing = StatusComposition.composing({
      text: "quote",
      visibility: Visibility.Public,
      quote: { kind: "Quoted", statusId: statusId.value },
      mediaIds: ["media-1"],
    });
    const validated = StatusComposition.validate(composing);
    expect(validated.isErr()).toBe(true);
    if (validated.isErr()) {
      expect(validated.error.kind).toBe("QuoteWithMediaOrPoll");
    }
  });

  it("keeps quote None as a discriminant, not an optional field", () => {
    expect(StatusQuoteTarget.none.kind).toBe("None");
  });
});
