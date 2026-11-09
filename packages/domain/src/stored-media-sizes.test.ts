import { err, ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import {
  StoredMediaSizes,
  type HeadStoredMedia,
  type ListUnsizedMedia,
  type RecordStoredMediaSizes,
  type StoredMediaSize,
  type UnsizedMedia,
} from "./stored-media-sizes";

type Fixture = Readonly<{
  rows: ReadonlyArray<UnsizedMedia>;
  objects: Readonly<Record<string, number | Error>>;
  recordFails?: boolean;
}>;

const harness = (fixture: Fixture) => {
  const heads: string[] = [];
  const records: Array<readonly [string, ReadonlyArray<StoredMediaSize>]> = [];
  const order = StoredMediaSizes.sources;
  const list: ListUnsizedMedia = async (cursor, limit) =>
    ok(
      fixture.rows
        .filter((row) => {
          const rank = order.indexOf(row.source) - order.indexOf(cursor.source);
          return rank > 0 || (rank === 0 && row.id > cursor.afterId);
        })
        .slice(0, limit),
    );
  const head: HeadStoredMedia = async (objectKey) => {
    heads.push(objectKey);
    const object = fixture.objects[objectKey];
    if (object instanceof Error) {
      throw object;
    }
    return object;
  };
  const record: RecordStoredMediaSizes = async (media, sizes) => {
    if (fixture.recordFails) {
      return err({ kind: "RepositoryError", message: "down" });
    }
    records.push([media.id, sizes]);
    return ok(undefined);
  };
  return { deps: { list, head, record }, heads, records };
};

const START = { source: "attachments", afterId: "" } as const;

describe("StoredMediaSizes.pass", () => {
  it("records the size each HEAD reports, original and preview, and 0 for a missing object", async () => {
    const { deps, records } = harness({
      rows: [
        {
          source: "attachments",
          id: "a1",
          objects: [
            { slot: "file", objectKey: "k1" },
            { slot: "preview", objectKey: "p1" },
          ],
        },
        { source: "avatars", id: "acct", objects: [{ slot: "file", objectKey: "gone" }] },
      ],
      objects: { k1: 1200, p1: 80 },
    });
    const pass = (await StoredMediaSizes.pass(deps, START, 10))._unsafeUnwrap();
    expect(records).toEqual([
      [
        "a1",
        [
          { slot: "file", objectKey: "k1", size: 1200 },
          { slot: "preview", objectKey: "p1", size: 80 },
        ],
      ],
      ["acct", [{ slot: "file", objectKey: "gone", size: 0 }]],
    ]);
    expect(pass.tally).toEqual({ sized: 2, missing: 1, deferred: 0 });
    expect(pass.reports).toEqual([
      { source: "avatars", id: "acct", objectKey: "gone", outcome: { kind: "Missing" } },
    ]);
    expect(pass.next).toBeUndefined();
  });

  it("records nothing for a row whose lookup failed, and reports it", async () => {
    const { deps, records } = harness({
      rows: [
        {
          source: "attachments",
          id: "a1",
          objects: [
            { slot: "file", objectKey: "k1" },
            { slot: "preview", objectKey: "flaky" },
          ],
        },
        { source: "emojis", id: "e1", objects: [{ slot: "file", objectKey: "emoji/e1" }] },
      ],
      objects: { k1: 10, flaky: new Error("R2 unavailable"), "emoji/e1": 7 },
    });
    const pass = (await StoredMediaSizes.pass(deps, START, 10))._unsafeUnwrap();
    expect(records.map(([id]) => id)).toEqual(["e1"]);
    expect(pass.tally).toEqual({ sized: 2, missing: 0, deferred: 1 });
    expect(pass.reports[0]).toEqual({
      source: "attachments",
      id: "a1",
      objectKey: "flaky",
      outcome: { kind: "Deferred", reason: "R2 unavailable" },
    });
  });

  it("reads a bounded page, continues after its last row across sources, and ends on a short page", async () => {
    const { deps, heads } = harness({
      rows: [
        { source: "attachments", id: "a1", objects: [{ slot: "file", objectKey: "k1" }] },
        { source: "avatars", id: "b1", objects: [{ slot: "file", objectKey: "av1" }] },
        { source: "headers", id: "b1", objects: [{ slot: "file", objectKey: "hd1" }] },
      ],
      objects: { k1: 1, av1: 2, hd1: 3 },
    });
    const first = (await StoredMediaSizes.pass(deps, START, 2))._unsafeUnwrap();
    expect(first.scanned).toBe(2);
    expect(heads).toEqual(["k1", "av1"]);
    expect(first.next).toEqual({ source: "avatars", afterId: "b1" });
    const second = (await StoredMediaSizes.pass(deps, first.next ?? START, 2))._unsafeUnwrap();
    expect(second.scanned).toBe(1);
    expect(heads).toEqual(["k1", "av1", "hd1"]);
    expect(second.next).toBeUndefined();
  });

  it("reports a record that failed, and fails when the rows cannot be listed", async () => {
    const { deps } = harness({
      rows: [{ source: "headers", id: "h", objects: [{ slot: "file", objectKey: "k" }] }],
      objects: { k: 5 },
      recordFails: true,
    });
    const pass = (await StoredMediaSizes.pass(deps, START, 10))._unsafeUnwrap();
    expect(pass.reports[0]?.outcome).toEqual({ kind: "Deferred", reason: "RecordFailed: down" });
    const failed = await StoredMediaSizes.pass(
      { ...deps, list: async () => err({ kind: "RepositoryError", message: "down" }) },
      START,
      10,
    );
    expect(failed.isErr()).toBe(true);
  });

  it("sums tallies", () => {
    expect(
      StoredMediaSizes.addTally(
        { sized: 1, missing: 2, deferred: 0 },
        { sized: 3, missing: 0, deferred: 1 },
      ),
    ).toEqual({ sized: 4, missing: 2, deferred: 1 });
  });
});
