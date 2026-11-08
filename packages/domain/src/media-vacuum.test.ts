import { err, ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import { MediaVacuum } from "./media-vacuum";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");

describe("MediaVacuum", () => {
  it("removes media unattached for longer than Mastodon's one-day TTL", () => {
    expect(MediaVacuum.cutoff(NOW)).toBe("2026-11-07T12:00:00.000Z");
  });

  it("deletes the rows, then their objects, and chains after a full batch", async () => {
    const calls: string[] = [];
    const pass = await MediaVacuum.pass(
      {
        deleteRows: async (createdBefore, limit) => {
          calls.push(`rows ${createdBefore} ${limit}`);
          return ok({ deleted: limit, objectKeys: ["attachments/a/1", "attachments/a/2"] });
        },
        deleteObjects: async (keys) => {
          calls.push(`objects ${keys.join(",")}`);
        },
      },
      NOW,
    );
    expect(pass._unsafeUnwrap()).toEqual({ deleted: MediaVacuum.batch, chained: true });
    expect(calls).toEqual([
      `rows 2026-11-07T12:00:00.000Z ${MediaVacuum.batch}`,
      "objects attachments/a/1,attachments/a/2",
    ]);
  });

  it("stops after a short batch and touches no objects when nothing went", async () => {
    let objectCalls = 0;
    const deps = {
      deleteRows: async () => ok({ deleted: 0, objectKeys: [] }),
      deleteObjects: async () => {
        objectCalls += 1;
      },
    };
    expect((await MediaVacuum.pass(deps, NOW))._unsafeUnwrap()).toEqual({
      deleted: 0,
      chained: false,
    });
    expect(objectCalls).toBe(0);
    const failed = await MediaVacuum.pass(
      {
        ...deps,
        deleteRows: async () => err({ kind: "RepositoryError" as const, message: "down" }),
      },
      NOW,
    );
    expect(failed.isErr()).toBe(true);
    expect(objectCalls).toBe(0);
  });
});
