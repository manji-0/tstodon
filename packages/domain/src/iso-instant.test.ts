import { describe, expect, it } from "vite-plus/test";
import { IsoInstant } from "./iso-instant";

describe("IsoInstant.parseRemote", () => {
  it("converts a UTC offset to canonical UTC with milliseconds", () => {
    expect(IsoInstant.parseRemote("2026-01-01T09:00:17+09:00")._unsafeUnwrap()).toBe(
      "2026-01-01T00:00:17.000Z",
    );
    expect(IsoInstant.parseRemote("2025-12-31T20:30:00-05:00")._unsafeUnwrap()).toBe(
      "2026-01-01T01:30:00.000Z",
    );
  });

  it("pins fractional digits to milliseconds", () => {
    expect(IsoInstant.parseRemote("2026-01-01T00:00:16Z")._unsafeUnwrap()).toBe(
      "2026-01-01T00:00:16.000Z",
    );
    expect(IsoInstant.parseRemote("2026-01-01T00:00:16.5Z")._unsafeUnwrap()).toBe(
      "2026-01-01T00:00:16.500Z",
    );
    expect(IsoInstant.parseRemote("2026-01-01T00:00:16.123456Z")._unsafeUnwrap()).toBe(
      "2026-01-01T00:00:16.123Z",
    );
  });

  it("sorts as strings in chronological order", () => {
    const sorted = [
      "2026-01-01T09:00:17+09:00",
      "2026-01-01T00:00:16Z",
      "2026-01-01T00:00:16.5Z",
      "2025-12-31T23:59:59Z",
    ]
      .map((value) => IsoInstant.parseRemote(value)._unsafeUnwrap())
      .toSorted();
    expect(sorted).toEqual([
      "2025-12-31T23:59:59.000Z",
      "2026-01-01T00:00:16.000Z",
      "2026-01-01T00:00:16.500Z",
      "2026-01-01T00:00:17.000Z",
    ]);
  });

  it("rejects text that is not an instant", () => {
    for (const value of ["", "not a timestamp", "2026-02-30T00:00:00Z", "2026-01-01"]) {
      expect(IsoInstant.parseRemote(value).isErr(), value).toBe(true);
    }
  });

  it("keeps IsoInstant.parse strict about offsets", () => {
    expect(IsoInstant.parse("2026-01-01T09:00:17+09:00").isErr()).toBe(true);
  });
});
