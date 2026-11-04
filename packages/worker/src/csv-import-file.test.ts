import type { ImportTypeValue } from "@tstodon/domain";
import { describe, expect, it } from "vite-plus/test";
import {
  accountKey,
  type ImportContext,
  type ImportFileError,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  type ParsedLine,
  parseImportFile,
} from "./csv-import-file";

const context: ImportContext = { localDomain: "example.com", publicOrigin: "https://example.com" };

const parse = (type: ImportTypeValue["kind"], text: string): ReadonlyArray<ParsedLine> => {
  const lines = parseImportFile({ kind: type }, new TextEncoder().encode(text), context);
  if (lines.isErr()) {
    throw new Error(lines.error.kind);
  }
  return lines.value;
};

const refused = (type: ImportTypeValue["kind"], bytes: Uint8Array): ImportFileError["kind"] => {
  const lines = parseImportFile({ kind: type }, bytes, context);
  if (lines.isOk()) {
    throw new Error("accepted");
  }
  return lines.error.kind;
};

const rows = (lines: ReadonlyArray<ParsedLine>) =>
  lines.map((line) => (line.kind === "Ready" ? line.row : line.failure.kind));

describe("header detection", () => {
  it("keeps a first row that only starts like a header name", () => {
    // A list called "title" holding "acct", a block of the user "acct", a domain "domain".
    expect(rows(parse("Lists", "title,acct\nNews,bob\n"))).toEqual([
      { kind: "Lists", listTitle: "title", handle: "acct" },
      { kind: "Lists", listTitle: "News", handle: "bob" },
    ]);
    expect(rows(parse("Blocks", "acct\nbob\n"))).toEqual([
      { kind: "Blocks", handle: "acct" },
      { kind: "Blocks", handle: "bob" },
    ]);
    expect(rows(parse("DomainBlocks", "domain\nspam.example\n"))).toEqual([
      { kind: "DomainBlocks", domain: "domain" },
      { kind: "DomainBlocks", domain: "spam.example" },
    ]);
    expect(rows(parse("Following", "acct\nbob\n"))).toHaveLength(2);
  });

  it("drops a first row that is a full header", () => {
    expect(rows(parse("Mutes", "Account address,Hide notifications\nbob,true\n"))).toEqual([
      { kind: "Mutes", handle: "bob", hideNotifications: true },
    ]);
    expect(rows(parse("Following", "acct,show boosts\nbob,false\n"))).toEqual([
      { kind: "Following", handle: "bob", reblogs: false, notify: false, languages: [] },
    ]);
    expect(rows(parse("Lists", "List name,Account address\nNews,bob\n"))).toEqual([
      { kind: "Lists", listTitle: "News", handle: "bob" },
    ]);
  });
});

describe("parseImportFile", () => {
  it("reads Mastodon's following.csv, with its header and per-follow options", () => {
    const lines = parse(
      "Following",
      'Account address,Show boosts,Notify on new posts,Languages\n@Bob@Remote.Example,false,true,"en, ja"\ncarol,true,false,\n',
    );
    expect(rows(lines)).toEqual([
      {
        kind: "Following",
        handle: "Bob@Remote.Example",
        reblogs: false,
        notify: true,
        languages: ["en", "ja"],
      },
      { kind: "Following", handle: "carol", reblogs: true, notify: false, languages: [] },
    ]);
    expect(lines.map((line) => (line.kind === "Ready" ? line.key : ""))).toEqual([
      "bob@remote.example",
      "carol@example.com",
    ]);
  });

  it("reads a following file with only addresses (older exports have no header)", () => {
    expect(rows(parse("Following", "bob@remote.example\n"))).toEqual([
      {
        kind: "Following",
        handle: "bob@remote.example",
        reblogs: true,
        notify: false,
        languages: [],
      },
    ]);
  });

  it("reads blocks, mutes, lists, domain blocks, and bookmarks", () => {
    expect(rows(parse("Blocks", "a@x.example\nb@y.example\n"))).toEqual([
      { kind: "Blocks", handle: "a@x.example" },
      { kind: "Blocks", handle: "b@y.example" },
    ]);
    expect(
      rows(
        parse("Mutes", "Account address,Hide notifications\na@x.example,false\nb@y.example,true\n"),
      ),
    ).toEqual([
      { kind: "Mutes", handle: "a@x.example", hideNotifications: false },
      { kind: "Mutes", handle: "b@y.example", hideNotifications: true },
    ]);
    expect(rows(parse("Lists", '"Friends, close",a@x.example\nNews,b@y.example\n'))).toEqual([
      { kind: "Lists", listTitle: "Friends, close", handle: "a@x.example" },
      { kind: "Lists", listTitle: "News", handle: "b@y.example" },
    ]);
    expect(rows(parse("DomainBlocks", "Spam.Example\nhttps://other.example/path\n"))).toEqual([
      { kind: "DomainBlocks", domain: "spam.example" },
      { kind: "DomainBlocks", domain: "other.example" },
    ]);
    expect(
      rows(
        parse(
          "Bookmarks",
          "https://example.com/users/bob/statuses/123\nhttps://example.com/@bob/456\nhttps://remote.example/users/x/statuses/9\n",
        ),
      ),
    ).toEqual([
      { kind: "Bookmarks", statusId: "123" },
      { kind: "Bookmarks", statusId: "456" },
      "Unsupported",
    ]);
  });

  it("fails a malformed row alone and keeps its position and text", () => {
    const lines = parse(
      "Following",
      "bob@remote.example\nnot a handle\ncarol@x.example,maybe\ndave@x.example,true,false,xx-\n",
    );
    expect(rows(lines)).toEqual([
      expect.objectContaining({ kind: "Following" }),
      "Malformed",
      "Malformed",
      "Malformed",
    ]);
    expect(lines.map((line) => line.position)).toEqual([1, 2, 3, 4]);
    expect(lines[1]?.input).toBe("not a handle");
  });

  it("refuses handles that carry a URL, a path, a second @, or control characters", () => {
    const bad = [
      "bob@evil.example/../x",
      "bob@evil.example#frag",
      "bob@evil.example?x=1",
      "bob@a@b",
      "https://evil.example/@bob",
      "bob@evil.example:99999999999999999999x",
      "bob@evil.example\u0000",
      "bo/b@x.example",
      "bob@",
      "@",
      `${"a".repeat(400)}@x.example`,
    ];
    for (const handle of bad) {
      expect(rows(parse("Blocks", `"${handle}"\n`)), handle).toEqual(["Malformed"]);
    }
  });

  it("refuses domains that are not host names", () => {
    expect(
      rows(parse("DomainBlocks", '"a b"\n"x.example\u0000"\n-bad.example\nunder_score.example\n')),
    ).toEqual(["Malformed", "Malformed", "Malformed", "Malformed"]);
  });

  it("refuses overlong list titles and bookmark URLs", () => {
    expect(rows(parse("Lists", `${"t".repeat(300)},bob@x.example\n`))).toEqual(["Malformed"]);
    expect(rows(parse("Bookmarks", `https://example.com/${"p".repeat(3000)}\n`))).toEqual([
      "Malformed",
    ]);
    expect(rows(parse("Bookmarks", "javascript:alert(1)\nnot a url\n"))).toEqual([
      "Unsupported",
      "Malformed",
    ]);
  });

  it("refuses a file that is too large, not UTF-8, unclosed, or has too many columns", () => {
    expect(refused("Blocks", new Uint8Array(MAX_IMPORT_BYTES + 1))).toBe("TooLarge");
    expect(refused("Blocks", new Uint8Array([0x62, 0xff, 0xfe, 0x0a]))).toBe("NotText");
    expect(refused("Blocks", new TextEncoder().encode('"bob@x.example\n'))).toBe("Unreadable");
    expect(refused("Blocks", new TextEncoder().encode("a,b,c,d,e,f,g,h,i\n"))).toBe("Unreadable");
    expect(refused("Blocks", new TextEncoder().encode("\n\n"))).toBe("NoRows");
    expect(refused("Following", new TextEncoder().encode("Account address\n"))).toBe("NoRows");
  });

  it("accepts exactly the row limit and refuses one more, with or without a header", () => {
    const at = (count: number) => Array.from({ length: count }, (_, i) => `u${i}@x.example`);
    expect(parse("Blocks", at(MAX_IMPORT_ROWS).join("\n"))).toHaveLength(MAX_IMPORT_ROWS);
    expect(parse("Following", ["Account address", ...at(MAX_IMPORT_ROWS)].join("\n"))).toHaveLength(
      MAX_IMPORT_ROWS,
    );
    expect(refused("Blocks", new TextEncoder().encode(at(MAX_IMPORT_ROWS + 1).join("\n")))).toBe(
      "TooManyRows",
    );
    expect(
      refused(
        "Following",
        new TextEncoder().encode(["Account address", ...at(MAX_IMPORT_ROWS + 1)].join("\n")),
      ),
    ).toBe("TooManyRows");
  });

  it("names an account the same way for the file and for the stored entries", () => {
    expect(accountKey("example.com", "Bob")).toBe("bob@example.com");
    expect(accountKey("example.com", "bob@Example.com")).toBe("bob@example.com");
    expect(accountKey("example.com", "not a handle")).toBeUndefined();
  });
});
