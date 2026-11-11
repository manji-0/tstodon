import { describe, expect, it } from "vite-plus/test";
import { noteFromUnknown } from "./remote-status-persist";

const author = { actorUri: "https://remote.example/users/alice" };

const note = (extra: Record<string, unknown>) => ({
  id: `${author.actorUri}/statuses/1`,
  type: "Note",
  attributedTo: author.actorUri,
  content: "<p>hi</p>",
  to: ["https://www.w3.org/ns/activitystreams#Public"],
  ...extra,
});

describe("remote note timestamps", () => {
  it("keeps the instant of a published value with a UTC offset, stored as UTC", () => {
    const parsed = noteFromUnknown(note({ published: "2026-01-01T09:00:17+09:00" }), author);
    expect(parsed._unsafeUnwrap().publishedAt).toBe("2026-01-01T00:00:17.000Z");
  });

  it("pads a published value to milliseconds", () => {
    const parsed = noteFromUnknown(note({ published: "2026-01-01T00:00:16Z" }), author);
    expect(parsed._unsafeUnwrap().publishedAt).toBe("2026-01-01T00:00:16.000Z");
  });

  it("falls back to receive time only for an unparsable value", () => {
    const before = Date.now();
    const parsed = noteFromUnknown(note({ published: "yesterday" }), author);
    expect(Date.parse(parsed._unsafeUnwrap().publishedAt)).toBeGreaterThanOrEqual(before);
  });
});
