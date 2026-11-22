import { describe, expect, it } from "vite-plus/test";
import { RepliesPage } from "./replies-page";

describe("RepliesPage", () => {
  it("reads Mastodon's page parameters", () => {
    expect(RepliesPage.fromQuery({})).toEqual({ kind: "SelfReplies" });
    expect(RepliesPage.fromQuery({ min_id: "5" })).toEqual({ kind: "SelfReplies", afterId: "5" });
    expect(RepliesPage.fromQuery({ only_other_accounts: "true" })).toEqual({
      kind: "OtherReplies",
    });
    expect(RepliesPage.fromQuery({ only_other_accounts: "1", min_id: "9" })).toEqual({
      kind: "OtherReplies",
      afterId: "9",
    });
    expect(RepliesPage.fromQuery({ only_other_accounts: "false" })).toEqual({
      kind: "SelfReplies",
    });
  });

  it("reads a flag as Rails casts a boolean: true unless empty or one of its false words", () => {
    for (const value of ["true", "1", "t", "yes", "on", "anything", "False"]) {
      expect(RepliesPage.truthy(value), value).toBe(true);
    }
    for (const value of [undefined, "", "0", "f", "F", "false", "FALSE", "off", "OFF"]) {
      expect(RepliesPage.truthy(value), String(value)).toBe(false);
    }
  });

  it("links a page with the parameters it is read from", () => {
    const pages: RepliesPage[] = [
      { kind: "SelfReplies" },
      { kind: "SelfReplies", afterId: "5" },
      { kind: "OtherReplies" },
      { kind: "OtherReplies", afterId: "7" },
    ];
    for (const page of pages) {
      const params = new URLSearchParams(RepliesPage.query(page));
      expect(params.get("page")).toBe("true");
      expect(
        RepliesPage.fromQuery({
          only_other_accounts: params.get("only_other_accounts") ?? undefined,
          min_id: params.get("min_id") ?? undefined,
        }),
      ).toEqual(page);
    }
    expect(RepliesPage.query({ kind: "OtherReplies" })).toBe("?only_other_accounts=true&page=true");
    expect(RepliesPage.query({ kind: "SelfReplies", afterId: "5" })).toBe("?min_id=5&page=true");
  });

  it("names a served page by the parameters it was asked with, as Mastodon's params_slice", () => {
    expect(RepliesPage.askedQuery({})).toBe("?page=true");
    expect(RepliesPage.askedQuery({ only_other_accounts: "1", min_id: "9" })).toBe(
      "?min_id=9&only_other_accounts=1&page=true",
    );
    expect(RepliesPage.askedQuery({ min_id: "" })).toBe("?min_id=&page=true");
  });

  it("stays on the author's replies while a page is full, then lists the other accounts'", () => {
    expect(RepliesPage.next({ kind: "SelfReplies" }, ["1", "2"], 2)).toEqual({
      kind: "SelfReplies",
      afterId: "2",
    });
    expect(RepliesPage.next({ kind: "SelfReplies" }, ["1"], 2)).toEqual({ kind: "OtherReplies" });
    expect(RepliesPage.next({ kind: "SelfReplies" }, [], 2)).toEqual({ kind: "OtherReplies" });
    expect(RepliesPage.next({ kind: "OtherReplies" }, ["1", "2"], 2)).toEqual({
      kind: "OtherReplies",
      afterId: "2",
    });
    expect(RepliesPage.next({ kind: "OtherReplies", afterId: "2" }, ["3"], 2)).toBeUndefined();
  });

  it("links an embedded first page on from its last reply, as Mastodon's NoteSerializer", () => {
    expect(RepliesPage.embeddedNext(["1", "2"])).toEqual({ kind: "SelfReplies", afterId: "2" });
    expect(RepliesPage.embeddedNext([])).toEqual({ kind: "OtherReplies" });
  });
});
