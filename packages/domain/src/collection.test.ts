import { describe, expect, it } from "vite-plus/test";
import { Collection, type CollectionFields } from "./collection";

const fields: CollectionFields = {
  name: "Friends",
  description: null,
  language: null,
  sensitive: false,
  discoverable: true,
  tagName: null,
};

const context = {
  tagUsable: true,
  liveItemCount: 0,
  knownLanguage: (code: string) => code === "en",
  ownerQuota: undefined,
};

const collection = (() => {
  const parsed = Collection.parse({
    kind: "LocalCollection",
    id: "1",
    accountId: "owner",
    name: "Friends",
    description: null,
    language: null,
    sensitive: false,
    discoverable: true,
    tagName: null,
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
    items: [
      {
        id: "i1",
        accountId: "a",
        position: 1,
        state: "accepted",
        createdAt: "2026-11-25T00:00:00.000Z",
      },
      {
        id: "i2",
        accountId: "b",
        position: 2,
        state: "pending",
        createdAt: "2026-11-25T00:00:00.000Z",
      },
      {
        id: "i3",
        accountId: "c",
        position: 3,
        state: "revoked",
        createdAt: "2026-11-25T00:00:00.000Z",
      },
    ],
  });
  if (parsed.isErr()) {
    throw new Error("fixture does not parse");
  }
  return parsed.value;
})();

describe("Collection", () => {
  it("validates as Mastodon's local Collection does, in its order", () => {
    expect(Collection.validate(fields, context)).toEqual([]);
    const errors = Collection.validate(
      { ...fields, name: " ", language: "xx", sensitive: null },
      { ...context, tagUsable: false, liveItemCount: 26, ownerQuota: { count: 10, limit: 10 } },
    );
    expect(errors.map((error) => `${error.attribute}:${error.error}`)).toEqual([
      "name:blank",
      "sensitive:inclusion",
      "language:invalid",
      "tag_name:unusable",
      "collection_items:too_many",
      "base:too_many",
    ]);
    expect(errors.map(Collection.fullMessage).slice(0, 2)).toEqual([
      "Name can't be blank",
      "Sensitive is not included in the list",
    ]);
  });

  it("counts characters, not UTF-16 units, against the name limit", () => {
    expect(Collection.validate({ ...fields, name: "🦣".repeat(40) }, context)).toEqual([]);
    expect(Collection.validate({ ...fields, name: "a".repeat(41) }, context)).toEqual([
      { attribute: "name", error: "too_long", message: "is too long (maximum is 40 characters)" },
    ]);
  });

  it("shows the owner its pending items, others the accepted ones, and no blocked account", () => {
    const ids = (viewer: string | undefined, blocked: ReadonlyArray<string> = []) =>
      Collection.itemsFor(collection, viewer, new Set(blocked)).map((item) => item.id);
    expect(ids("owner")).toEqual(["i1", "i2"]);
    expect(ids(undefined)).toEqual(["i1"]);
    expect(ids("someone", ["a"])).toEqual([]);
  });

  it("features a discoverable account that is unlocked, followed, or the owner", () => {
    const candidate = {
      ownerId: "owner",
      targetId: "t",
      targetDiscoverable: true,
      targetLocked: false,
      ownerFollowsTarget: false,
      blockedEitherWay: false,
    };
    expect(Collection.featureable(candidate)).toBe(true);
    expect(Collection.featureable({ ...candidate, targetDiscoverable: false })).toBe(false);
    expect(Collection.featureable({ ...candidate, targetLocked: true })).toBe(false);
    expect(
      Collection.featureable({ ...candidate, targetLocked: true, ownerFollowsTarget: true }),
    ).toBe(true);
    expect(Collection.featureable({ ...candidate, targetLocked: true, targetId: "owner" })).toBe(
      true,
    );
    expect(Collection.featureable({ ...candidate, blockedEitherWay: true })).toBe(false);
  });
});
