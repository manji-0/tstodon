import { describe, expect, it } from "vitest";
import { Announcement } from "./announcement";

describe("Announcement", () => {
  it("parses a published announcement", () => {
    const parsed = Announcement.parse({
      kind: "Announcement",
      id: "1",
      content: "Welcome to tstodon",
      publishedAt: "2026-09-22T12:00:00.000Z",
      updatedAt: "2026-09-22T12:00:00.000Z",
      startsAt: null,
      endsAt: null,
      allDay: false,
    });
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.id).toBe("1");
      expect(parsed.value.startsAt).toBeNull();
    }
  });

  it("rejects blank content", () => {
    expect(
      Announcement.parse({
        kind: "Announcement",
        id: "1",
        content: "",
        publishedAt: "2026-09-22T12:00:00.000Z",
        updatedAt: "2026-09-22T12:00:00.000Z",
        startsAt: null,
        endsAt: null,
        allDay: false,
      }).isErr(),
    ).toBe(true);
  });
});
