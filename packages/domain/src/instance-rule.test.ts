import { describe, expect, it } from "vitest";
import { InstanceRule } from "./instance-rule";

describe("InstanceRule", () => {
  it("parses a valid rule", () => {
    const parsed = InstanceRule.parse({
      kind: "InstanceRule",
      id: "1",
      text: "Be excellent to each other",
    });
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.text).toBe("Be excellent to each other");
    }
  });

  it("rejects blank text", () => {
    expect(InstanceRule.parse({ kind: "InstanceRule", id: "1", text: "" }).isErr()).toBe(true);
  });

  it("builds a rule from text with a 1-based id", () => {
    expect(InstanceRule.fromText("No spam", 0)).toEqual({
      kind: "InstanceRule",
      id: "1",
      text: "No spam",
    });
  });
});
