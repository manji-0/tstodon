import { describe, expect, it } from "vite-plus/test";
import { entityIdAt, newEntityId } from "./ids";

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

  it("never sorts after now", () => {
    const future = BigInt(entityIdAt(Date.parse("2999-01-01T00:00:00.000Z"))) >> 16n;
    const later = BigInt(newEntityId()) >> 16n;
    expect(future <= later).toBe(true);
  });
});
