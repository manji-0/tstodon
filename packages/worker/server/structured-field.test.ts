import { describe, expect, it } from "vite-plus/test";
import {
  parseSfDictionary,
  type SfDictionary,
  type SfInnerList,
  serializeSfInnerList,
  serializeSfItem,
} from "./structured-field";

const parsed = (field: string): SfDictionary => {
  const result = parseSfDictionary(field);
  if (result.isErr()) {
    throw new Error(`${field} did not parse at ${result.error.at}`);
  }
  return result.value;
};

const innerList = (field: string, key: string): SfInnerList => {
  const member = parsed(field).find(([name]) => name === key)?.[1];
  if (member?.kind !== "InnerList") {
    throw new Error(`${key} is not an inner list`);
  }
  return member;
};

describe("parseSfDictionary", () => {
  it("reads RFC 9421's Signature-Input, its components and parameters", () => {
    const list = innerList(
      'sig1=("@method" "@target-uri" "content-digest");created=1618884473;keyid="test-key-rsa"',
      "sig1",
    );
    expect(list.items.map((item) => item.value)).toEqual([
      { kind: "String", value: "@method" },
      { kind: "String", value: "@target-uri" },
      { kind: "String", value: "content-digest" },
    ]);
    expect(list.params).toEqual([
      ["created", { kind: "Integer", value: 1618884473 }],
      ["keyid", { kind: "String", value: "test-key-rsa" }],
    ]);
  });

  it("reads a byte sequence, as Signature and Content-Digest carry", () => {
    expect(parsed("sha-256=:AQID:, sha-512=:/w==:")).toEqual([
      [
        "sha-256",
        {
          kind: "Item",
          value: { kind: "ByteSequence", value: Uint8Array.of(1, 2, 3) },
          params: [],
        },
      ],
      [
        "sha-512",
        { kind: "Item", value: { kind: "ByteSequence", value: Uint8Array.of(255) }, params: [] },
      ],
    ]);
  });

  it("reads each bare item type, a bare key as true, and a field sent on two lines", () => {
    expect(parsed('a=1, b=-2.5, c="x\\"y", d=tok/en:1, e=?0, f;p=*t, g=()')).toEqual([
      ["a", { kind: "Item", value: { kind: "Integer", value: 1 }, params: [] }],
      ["b", { kind: "Item", value: { kind: "Decimal", value: -2.5 }, params: [] }],
      ["c", { kind: "Item", value: { kind: "String", value: 'x"y' }, params: [] }],
      ["d", { kind: "Item", value: { kind: "Token", value: "tok/en:1" }, params: [] }],
      ["e", { kind: "Item", value: { kind: "Boolean", value: false }, params: [] }],
      [
        "f",
        {
          kind: "Item",
          value: { kind: "Boolean", value: true },
          params: [["p", { kind: "Token", value: "*t" }]],
        },
      ],
      ["g", { kind: "InnerList", items: [], params: [] }],
    ]);
  });

  it("reads a field with a long run of spaces in linear time", () => {
    const spaces = " ".repeat(100_000);
    const started = Date.now();
    expect(parseSfDictionary(`a${spaces}b`).isErr()).toBe(true);
    expect(parseSfDictionary(`${spaces}a=1${spaces}`).isOk()).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("reads an empty field as an empty dictionary", () => {
    expect(parsed("")).toEqual([]);
  });

  it("keeps a repeated key at its first place with its last value", () => {
    expect(
      parsed("a=1, b=2, a=3").map(([key, member]) => [
        key,
        member.kind === "Item" ? member.value : undefined,
      ]),
    ).toEqual([
      ["a", { kind: "Integer", value: 3 }],
      ["b", { kind: "Integer", value: 2 }],
    ]);
  });

  it.each([
    ["an uppercase key", "Sig1=1"],
    ["a trailing comma", "a=1,"],
    ["a missing comma", "a=1 b=2"],
    ["an unclosed inner list", 'a=("x"'],
    ["an unclosed string", 'a="x'],
    ["a bad escape", 'a="\\x"'],
    ["a non-ASCII string", 'a="é"'],
    ["an unclosed byte sequence", "a=:AQID"],
    ["a byte sequence with a space", "a=:AQ ID:"],
    ["four decimal places", "a=1.2345"],
    ["a 16-digit integer", "a=1234567890123456"],
    ["a 13-digit integer part", "a=1234567890123.1"],
    ["a trailing dot", "a=1."],
    ["an RFC 9651 date", "a=@1659578233"],
    ["a boolean that is neither 0 nor 1", "a=?2"],
    ["items run together in a list", 'a=("x""y")'],
  ])("refuses %s", (_, field) => {
    expect(parseSfDictionary(field).isErr()).toBe(true);
  });
});

describe("serializeSfInnerList", () => {
  it("writes a parsed Signature-Input member back as it was sent, which RFC 9421 signs", () => {
    const sent =
      '("@method" "@target-uri" "content-digest";sf);created=1618884473;keyid="a\\"b";alg="ed25519";v=1.5;b=?0;t';
    expect(serializeSfInnerList(innerList(`sig=${sent}`, "sig"))).toBe(sent);
  });

  it("writes the canonical form of what was sent loosely", () => {
    expect(serializeSfInnerList(innerList('sig=(  "a"   "b" );x=1.50;y=:AQID:', "sig"))).toBe(
      '("a" "b");x=1.5;y=:AQID:',
    );
    expect(
      serializeSfItem({ kind: "Item", value: { kind: "Decimal", value: 2 }, params: [] }),
    ).toBe("2.0");
  });
});
