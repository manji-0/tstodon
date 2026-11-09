import { describe, expect, it } from "vite-plus/test";
import { StatusComposition } from "./status-composition";
import { StatusId } from "./status-id";
import { StatusQuoteTarget } from "./status-quote-target";
import { StatusTarget } from "./status-target";
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
      quote: { kind: "Quoted", target: StatusTarget.local(statusId.value) },
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

  it("shares the 500-character limit between the content warning and the body", () => {
    const check = (text: string, spoilerText = "") =>
      StatusComposition.validate(
        StatusComposition.composing({ text, spoilerText, visibility: Visibility.Public }),
      );
    expect(check("a".repeat(500)).isOk()).toBe(true);
    expect(check("a".repeat(501)).isErr()).toBe(true);
    expect(check("a".repeat(250), "c".repeat(250)).isOk()).toBe(true);
    const over = check("a".repeat(250), "c".repeat(251));
    expect(over.isErr() && over.error).toEqual({ kind: "TooLong", field: "text", limit: 500 });
  });

  it("counts a URL as 23 characters and a remote mention without its domain", () => {
    const url = `https://example.com/${"p".repeat(600)}`;
    const check = (text: string) =>
      StatusComposition.validate(
        StatusComposition.composing({ text, visibility: Visibility.Public }),
      ).isOk();
    // 476 + 1 + 23 = 500.
    expect(check(`${"a".repeat(476)} ${url}`)).toBe(true);
    expect(check(`${"a".repeat(477)} ${url}`)).toBe(false);
    const mention = "@alice@a-very-long-domain-name.example.social";
    // 493 + 1 + 6 ("@alice") = 500.
    expect(check(`${"a".repeat(493)} ${mention}`)).toBe(true);
    expect(check(`${"a".repeat(494)} ${mention}`)).toBe(false);
  });
});
