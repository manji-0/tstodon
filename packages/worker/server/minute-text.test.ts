import { describe, expect, it } from "vite-plus/test";
import { minuteText } from "./settings-pages";

describe("minuteText", () => {
  it("shows a stored timestamp to the minute in UTC", () => {
    expect(minuteText("2026-11-11T17:05:18.949Z")).toBe("2026-11-11 17:05 UTC");
  });

  it("shows text that is not a date as it is", () => {
    expect(minuteText("not a date")).toBe("not a date");
    expect(minuteText("")).toBe("");
  });
});
