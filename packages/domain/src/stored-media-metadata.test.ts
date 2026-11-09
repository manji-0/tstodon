import { err, ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import {
  StoredMediaMetadata,
  type ListUnstrippedMedia,
  type MarkStoredMedia,
  type ReadStoredMedia,
  type StoredMediaMark,
  type StoredMediaObject,
  type StoredMediaSource,
  type UnstrippedMedia,
} from "./stored-media-metadata";

/** Bytes of no known container: nothing to strip, as a GIF. */
const OPAQUE = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0]);
/** A PNG signature and nothing after it: a container that does not hold together. */
const BROKEN_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const LIMITS = { rows: 2, bytes: 1_000, objectBytes: 100 };

type Fixture = Readonly<{
  rows: Readonly<Partial<Record<StoredMediaSource, ReadonlyArray<UnstrippedMedia>>>>;
  objects: Readonly<Record<string, StoredMediaObject | Error>>;
  markFails?: boolean;
}>;

const harness = (fixture: Fixture) => {
  const marks: Array<Readonly<{ source: StoredMediaSource; id: string; mark: StoredMediaMark }>> =
    [];
  const reads: string[] = [];
  const list: ListUnstrippedMedia = async (source, afterId, limit) =>
    ok((fixture.rows[source] ?? []).filter((row) => row.id > afterId).slice(0, limit));
  const read: ReadStoredMedia = async (objectKey) => {
    reads.push(objectKey);
    const object = fixture.objects[objectKey] ?? { kind: "Missing" };
    if (object instanceof Error) {
      throw object;
    }
    return object;
  };
  const mark: MarkStoredMedia = async (source, media, value) => {
    if (fixture.markFails) {
      return err({ kind: "RepositoryError", message: "down" });
    }
    marks.push({ source, id: media.id, mark: value });
    return ok(undefined);
  };
  return { deps: { list, read, mark }, marks, reads };
};

const found = (bytes: Uint8Array, writes: Uint8Array[] = []): StoredMediaObject => ({
  kind: "Found",
  bytes,
  replace: async (next) => {
    writes.push(next);
    return true;
  },
});

describe("StoredMediaMetadata.strip", () => {
  it("leaves bytes of no known container unchanged and refuses a broken one", () => {
    expect(StoredMediaMetadata.strip(OPAQUE)._unsafeUnwrap()).toEqual({ kind: "Unchanged" });
    expect(StoredMediaMetadata.strip(BROKEN_PNG).isErr()).toBe(true);
  });
});

describe("StoredMediaMetadata.pass", () => {
  it("marks clean rows without writing, and continues after a full page", async () => {
    const writes: Uint8Array[] = [];
    const { deps, marks } = harness({
      rows: {
        attachments: [
          { id: "a1", objectKeys: ["k1"] },
          { id: "a2", objectKeys: ["k2", "legacy2"] },
          { id: "a3", objectKeys: ["k3"] },
        ],
      },
      objects: { k1: found(OPAQUE, writes), k2: found(OPAQUE, writes) },
    });
    const pass = (
      await StoredMediaMetadata.pass(deps, { source: "attachments", afterId: "" }, LIMITS)
    )._unsafeUnwrap();
    expect(writes).toEqual([]);
    expect(pass.scanned).toBe(2);
    expect(pass.next).toEqual({ source: "attachments", afterId: "a2" });
    // A legacy copy already gone has nothing left to strip.
    expect(pass.tally).toEqual({ ...StoredMediaMetadata.emptyTally, unchanged: 2, missing: 1 });
    expect(marks).toEqual([
      { source: "attachments", id: "a1", mark: { kind: "Clean" } },
      { source: "attachments", id: "a2", mark: { kind: "Clean" } },
    ]);
  });

  it("moves to avatars, then headers, then stops", async () => {
    const { deps } = harness({
      rows: { avatars: [{ id: "acct", objectKeys: ["avatars/acct/1"] }] },
      objects: { "avatars/acct/1": found(OPAQUE) },
    });
    const attachments = (
      await StoredMediaMetadata.pass(deps, { source: "attachments", afterId: "" }, LIMITS)
    )._unsafeUnwrap();
    expect(attachments.next).toEqual({ source: "avatars", afterId: "" });
    const avatars = (
      await StoredMediaMetadata.pass(deps, { source: "avatars", afterId: "" }, LIMITS)
    )._unsafeUnwrap();
    expect(avatars.scanned).toBe(1);
    expect(avatars.next).toEqual({ source: "headers", afterId: "" });
    const headers = (
      await StoredMediaMetadata.pass(deps, { source: "headers", afterId: "" }, LIMITS)
    )._unsafeUnwrap();
    expect(headers.next).toBeUndefined();
  });

  it("passes over unreadable and oversized objects, and leaves failed reads unmarked", async () => {
    const { deps, marks } = harness({
      rows: {
        headers: [
          { id: "h1", objectKeys: ["broken"] },
          { id: "h2", objectKeys: ["huge"] },
          { id: "h3", objectKeys: ["flaky"] },
        ],
      },
      objects: {
        broken: found(BROKEN_PNG),
        huge: { kind: "TooLarge", size: 500 },
        flaky: new Error("R2 unavailable"),
      },
    });
    const pass = (
      await StoredMediaMetadata.pass(
        deps,
        { source: "headers", afterId: "" },
        { ...LIMITS, rows: 10 },
      )
    )._unsafeUnwrap();
    expect(pass.tally).toEqual({
      ...StoredMediaMetadata.emptyTally,
      unreadable: 1,
      tooLarge: 1,
      deferred: 1,
    });
    expect(marks.map((entry) => [entry.id, entry.mark.kind])).toEqual([
      ["h1", "PassedOver"],
      ["h2", "PassedOver"],
    ]);
    expect(marks[1]?.mark).toEqual({ kind: "PassedOver", reason: "TooLarge: 500 bytes" });
    expect(pass.reports.map((report) => [report.objectKey, report.outcome.kind])).toEqual([
      ["broken", "Unreadable"],
      ["huge", "TooLarge"],
      ["flaky", "Deferred"],
    ]);
    expect(pass.next).toBeUndefined();
  });

  it("stops early once its byte budget is spent and resumes after the last row read", async () => {
    const { deps, reads } = harness({
      rows: {
        attachments: [
          { id: "a1", objectKeys: ["k1"] },
          { id: "a2", objectKeys: ["k2"] },
        ],
      },
      objects: { k1: found(OPAQUE), k2: found(OPAQUE) },
    });
    const pass = (
      await StoredMediaMetadata.pass(
        deps,
        { source: "attachments", afterId: "" },
        { rows: 10, bytes: OPAQUE.length, objectBytes: 100 },
      )
    )._unsafeUnwrap();
    expect(reads).toEqual(["k1"]);
    expect(pass.next).toEqual({ source: "attachments", afterId: "a1" });
  });

  it("reports a mark that failed to record, and fails when the rows cannot be listed", async () => {
    const { deps } = harness({
      rows: { avatars: [{ id: "acct", objectKeys: ["k"] }] },
      objects: { k: found(OPAQUE) },
      markFails: true,
    });
    const pass = (
      await StoredMediaMetadata.pass(deps, { source: "avatars", afterId: "" }, LIMITS)
    )._unsafeUnwrap();
    expect(pass.reports[0]?.outcome).toEqual({ kind: "Deferred", reason: "MarkFailed: down" });
    const failed = await StoredMediaMetadata.pass(
      { ...deps, list: async () => err({ kind: "RepositoryError", message: "down" }) },
      { source: "avatars", afterId: "" },
      LIMITS,
    );
    expect(failed.isErr()).toBe(true);
  });

  it("sums tallies", () => {
    const one = { ...StoredMediaMetadata.emptyTally, stripped: 1, missing: 2 };
    expect(StoredMediaMetadata.addTally(one, one)).toEqual({
      ...StoredMediaMetadata.emptyTally,
      stripped: 2,
      missing: 4,
    });
  });
});
