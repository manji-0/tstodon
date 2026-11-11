import { describe, expect, it } from "vite-plus/test";
import { ok } from "neverthrow";
import type { ListIpBlocks } from "@tstodon/domain";
import { currentIpBlocks, forgetIpBlocks } from "./ip-access";

/** A block list read that counts its calls and answers with no blocks. */
const countingList = (): { list: ListIpBlocks; calls: () => number } => {
  let calls = 0;
  return {
    list: async () => {
      calls += 1;
      return ok([]);
    },
    calls: () => calls,
  };
};

describe("currentIpBlocks", () => {
  it("does not make a request wait on another request's read", async () => {
    forgetIpBlocks();
    // A read that never settles, as a D1 read does when workerd cancels the
    // request that started it (its client went away).
    const stuck: ListIpBlocks = () => new Promise(() => undefined);
    void currentIpBlocks(stuck);

    const other = countingList();
    await expect(currentIpBlocks(other.list)).resolves.toEqual([]);
    expect(other.calls()).toBe(1);
  });

  it("reuses a finished read until it is stale", async () => {
    forgetIpBlocks();
    const reads = countingList();
    await currentIpBlocks(reads.list, 1_000);
    await currentIpBlocks(reads.list, 30_000);
    expect(reads.calls()).toBe(1);
    await currentIpBlocks(reads.list, 70_000);
    expect(reads.calls()).toBe(2);
  });

  it("does not keep a read that started before the list was forgotten", async () => {
    forgetIpBlocks();
    let finish: () => void = () => undefined;
    const slow: ListIpBlocks = () =>
      new Promise((resolve) => {
        finish = () => resolve(ok([]));
      });
    const pending = currentIpBlocks(slow, 1_000);
    forgetIpBlocks();
    finish();
    await pending;

    const after = countingList();
    await currentIpBlocks(after.list, 2_000);
    expect(after.calls()).toBe(1);
  });
});
