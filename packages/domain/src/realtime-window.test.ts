import { describe, expect, it } from "vite-plus/test";
import { IsoInstant } from "./iso-instant";
import { RealtimeWindow } from "./realtime-window";

const instant = (value: string): IsoInstant => IsoInstant.parse(value)._unsafeUnwrap();
const now = instant("2026-11-11T12:00:00.000Z");

describe("RealtimeWindow", () => {
  it("contains a post up to six hours old", () => {
    expect(RealtimeWindow.contains(instant("2026-11-11T11:59:00.000Z"), now)).toBe(true);
    expect(RealtimeWindow.contains(instant("2026-11-11T06:00:00.000Z"), now)).toBe(true);
  });

  it("excludes a post older than six hours", () => {
    expect(RealtimeWindow.contains(instant("2026-11-11T05:59:59.999Z"), now)).toBe(false);
    expect(RealtimeWindow.contains(instant("2026-11-01T00:00:00.000Z"), now)).toBe(false);
  });

  it("contains a post dated slightly ahead of the clock", () => {
    expect(RealtimeWindow.contains(instant("2026-11-11T12:00:30.000Z"), now)).toBe(true);
  });
});
