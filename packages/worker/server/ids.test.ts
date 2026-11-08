import { describe, expect, it } from "vite-plus/test";
import { entityIdAt, newEntityId, rerollEntityId } from "./ids";

describe("entityIdAt", () => {
  it("sorts ids as strings in the order of their instants, before 2018 too", () => {
    const instants = [
      "2016-04-01T00:00:00.000Z",
      "2018-05-17T00:00:00.000Z",
      "2024-02-02T00:00:00.000Z",
    ];
    const ids = instants.map((instant) => entityIdAt(Date.parse(instant)));
    ids.push(newEntityId());
    expect(ids.map((id) => id.length)).toEqual([18, 18, 18, 18]);
    expect([...ids].sort()).toEqual(ids);
  });

  it("gives every id distinct at one instant, as a backfill of one second does", () => {
    const at = Date.parse("2024-03-03T00:00:00.000Z");
    const ids = Array.from({ length: 5000 }, () => entityIdAt(at));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids.map((id) => BigInt(id) >> 16n)).size).toBe(1);
  });

  it("gives every id distinct in a burst that shares the clock", () => {
    const ids = Array.from({ length: 5000 }, () => newEntityId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not reveal a neighbor's id at one instant", () => {
    const at = Date.parse("2024-04-04T00:00:00.000Z");
    const lows = Array.from({ length: 64 }, () => Number(BigInt(entityIdAt(at)) & 0xffffn));
    const steps = lows.slice(1).map((low, index) => (low - (lows[index] ?? 0) + 0x10000) % 0x10000);
    expect(new Set(steps).size).toBeGreaterThan(32);
  });

  it("rerolls a collided id to another id at the same instant", () => {
    const id = entityIdAt(Date.parse("2024-05-05T00:00:00.000Z"));
    const rerolled = rerollEntityId(id);
    expect(rerolled).not.toBe(id);
    expect(BigInt(rerolled) >> 16n).toBe(BigInt(id) >> 16n);
  });

  it("refuses a 65,537th id at one instant instead of repeating one", () => {
    const at = Date.parse("2024-06-06T00:00:00.000Z");
    const ids = new Set(Array.from({ length: 65_536 }, () => entityIdAt(at)));
    expect(ids.size).toBe(65_536);
    expect(() => entityIdAt(at)).toThrow();
  });

  it("never sorts after now", () => {
    const future = BigInt(entityIdAt(Date.parse("2999-01-01T00:00:00.000Z"))) >> 16n;
    const later = BigInt(newEntityId()) >> 16n;
    expect(future <= later).toBe(true);
  });
});
