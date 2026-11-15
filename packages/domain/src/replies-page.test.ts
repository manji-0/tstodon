import { describe, expect, it } from "vite-plus/test";
import { RepliesPage } from "./replies-page";

describe("RepliesPage", () => {
  it("reads Mastodon's page parameters", () => {
    expect(RepliesPage.fromQuery({})).toEqual({ kind: "SelfReplies" });
    expect(RepliesPage.fromQuery({ min_id: "5" })).toEqual({ kind: "SelfReplies", afterId: "5" });
    expect(RepliesPage.fromQuery({ only_other_accounts: "true" })).toEqual({
      kind: "LocalReplies",
    });
    expect(
      RepliesPage.fromQuery({ only_other_accounts: "1", remote: "true", min_id: "r9" }),
    ).toEqual({ kind: "RemoteReplies", afterId: "r9" });
    expect(RepliesPage.fromQuery({ only_other_accounts: "false", remote: "true" })).toEqual({
      kind: "SelfReplies",
    });
  });

  it("links a page with the parameters it is read from", () => {
    const pages: RepliesPage[] = [
      { kind: "SelfReplies" },
      { kind: "SelfReplies", afterId: "5" },
      { kind: "LocalReplies" },
      { kind: "LocalReplies", afterId: "7" },
      { kind: "RemoteReplies" },
      { kind: "RemoteReplies", afterId: "r9" },
    ];
    for (const page of pages) {
      const params = new URLSearchParams(RepliesPage.query(page));
      expect(params.get("page")).toBe("true");
      expect(
        RepliesPage.fromQuery({
          only_other_accounts: params.get("only_other_accounts") ?? undefined,
          remote: params.get("remote") ?? undefined,
          min_id: params.get("min_id") ?? undefined,
        }),
      ).toEqual(page);
    }
    expect(RepliesPage.query({ kind: "LocalReplies" })).toBe("?only_other_accounts=true&page=true");
  });

  it("stays in a stage while its pages are full, then moves to the next", () => {
    expect(RepliesPage.next({ kind: "SelfReplies" }, ["1", "2"], 2)).toEqual({
      kind: "SelfReplies",
      afterId: "2",
    });
    expect(RepliesPage.next({ kind: "SelfReplies" }, ["1"], 2)).toEqual({ kind: "LocalReplies" });
    expect(RepliesPage.next({ kind: "SelfReplies" }, [], 2)).toEqual({ kind: "LocalReplies" });
    expect(RepliesPage.next({ kind: "LocalReplies", afterId: "2" }, ["3"], 2)).toEqual({
      kind: "RemoteReplies",
    });
    expect(RepliesPage.next({ kind: "RemoteReplies" }, ["r1", "r2"], 2)).toEqual({
      kind: "RemoteReplies",
      afterId: "r2",
    });
    expect(RepliesPage.next({ kind: "RemoteReplies" }, ["r1"], 2)).toBeUndefined();
  });
});
