import { describe, expect, it } from "vite-plus/test";
import { CollectionPage, type CollectionCursor } from "./collection-page";

describe("CollectionPage", () => {
  it("reads `page` as each Mastodon controller does", () => {
    expect(CollectionPage.fromQuery({}, "Present")).toEqual({ kind: "Root" });
    expect(CollectionPage.fromQuery({ page: "" }, "Present")).toEqual({ kind: "Root" });
    expect(CollectionPage.fromQuery({ page: "1" }, "Present")).toEqual({
      kind: "Page",
      cursor: { kind: "Newest" },
    });
    expect(CollectionPage.fromQuery({ page: "false" }, "Present").kind).toBe("Page");
    expect(CollectionPage.fromQuery({ page: "false" }, "Truthy")).toEqual({ kind: "Root" });
    expect(CollectionPage.fromQuery({ page: "0" }, "Truthy")).toEqual({ kind: "Root" });
    expect(CollectionPage.fromQuery({ page: "true", max_id: "9" }, "Truthy")).toEqual({
      kind: "Page",
      cursor: { kind: "Before", id: "9" },
    });
    expect(CollectionPage.fromQuery({ page: "true", max_id: "9", min_id: "3" }, "Truthy")).toEqual({
      kind: "Page",
      cursor: { kind: "After", id: "3" },
    });
  });

  it("refuses a cursor that is not an id", () => {
    expect(CollectionPage.querySchema.safeParse({ max_id: "abc" }).success).toBe(false);
    expect(CollectionPage.querySchema.safeParse({ min_id: "0" }).success).toBe(true);
  });

  it("links a page with the parameters it is read from", () => {
    const cursors: CollectionCursor[] = [
      { kind: "Newest" },
      { kind: "Before", id: "12" },
      { kind: "After", id: "0" },
    ];
    for (const cursor of cursors) {
      const params = new URLSearchParams(CollectionPage.query(cursor));
      expect(
        CollectionPage.fromQuery(
          {
            page: params.get("page") ?? undefined,
            max_id: params.get("max_id") ?? undefined,
            min_id: params.get("min_id") ?? undefined,
          },
          "Truthy",
        ),
      ).toEqual({ kind: "Page", cursor });
    }
    expect(CollectionPage.query({ kind: "After", id: "0" })).toBe("?min_id=0&page=true");
    expect(CollectionPage.query({ kind: "Newest" }, "1")).toBe("?page=1");
  });

  it("orders a page newest first whichever way it was read", () => {
    expect(CollectionPage.take({ kind: "Newest" }, ["5", "4", "3"], 2)).toEqual({
      items: ["5", "4"],
      more: true,
    });
    expect(CollectionPage.take({ kind: "After", id: "1" }, ["2", "3", "4"], 2)).toEqual({
      items: ["3", "2"],
      more: true,
    });
    expect(CollectionPage.take({ kind: "Before", id: "3" }, ["2", "1"], 2)).toEqual({
      items: ["2", "1"],
      more: false,
    });
  });

  it("links follow pages only where a page lies", () => {
    expect(CollectionPage.followsLinks({ kind: "Newest" }, ["9", "8"], true)).toEqual({
      next: { kind: "Before", id: "8" },
    });
    expect(CollectionPage.followsLinks({ kind: "Newest" }, ["9", "8"], false)).toEqual({});
    expect(CollectionPage.followsLinks({ kind: "Before", id: "9" }, ["8", "7"], false)).toEqual({
      prev: { kind: "After", id: "8" },
    });
    expect(CollectionPage.followsLinks({ kind: "After", id: "7" }, ["9", "8"], false)).toEqual({
      next: { kind: "Before", id: "8" },
    });
    expect(CollectionPage.followsLinks({ kind: "After", id: "6" }, ["8", "7"], true)).toEqual({
      next: { kind: "Before", id: "7" },
      prev: { kind: "After", id: "8" },
    });
    expect(CollectionPage.followsLinks({ kind: "Before", id: "1" }, [], false)).toEqual({});
  });

  it("links outbox pages as Mastodon does: `next` when full, `prev` when not empty", () => {
    expect(CollectionPage.outboxLinks(["9", "8"], 2)).toEqual({
      next: { kind: "Before", id: "8" },
      prev: { kind: "After", id: "9" },
    });
    expect(CollectionPage.outboxLinks(["9"], 2)).toEqual({ prev: { kind: "After", id: "9" } });
    expect(CollectionPage.outboxLinks([], 2)).toEqual({});
  });
});
