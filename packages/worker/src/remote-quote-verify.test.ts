import { describe, expect, it } from "vite-plus/test";
import { stampAuthorizes } from "./remote-quote-verify";

const expected = {
  uri: "https://other.example/users/carol/stamps/1",
  quotingUri: "https://remote.example/notes/bob",
  quotedUri: "https://other.example/notes/carol",
  quotedActorUri: "https://other.example/users/carol",
};

const stamp = (overrides: Record<string, unknown> = {}) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: expected.uri,
  type: "QuoteAuthorization",
  attributedTo: expected.quotedActorUri,
  interactingObject: expected.quotingUri,
  interactionTarget: expected.quotedUri,
  ...overrides,
});

describe("stampAuthorizes", () => {
  it("accepts the stamp naming both notes and the quoted author", () => {
    expect(stampAuthorizes(stamp(), expected)).toBe(true);
  });

  it("reads the type from an array and the ends by id", () => {
    expect(
      stampAuthorizes(
        stamp({
          type: ["QuoteAuthorization", "Object"],
          attributedTo: { id: expected.quotedActorUri },
          interactingObject: { id: expected.quotingUri },
          interactionTarget: { id: expected.quotedUri, type: "Note" },
        }),
        expected,
      ),
    ).toBe(true);
  });

  it.each([
    ["another type", { type: "Note" }],
    ["another quoting note", { interactingObject: "https://remote.example/notes/other" }],
    ["another quoted note", { interactionTarget: "https://other.example/notes/other" }],
    ["another author", { attributedTo: "https://other.example/users/dave" }],
    ["an author on another host", { attributedTo: "https://elsewhere.example/users/carol" }],
    ["another id", { id: "https://other.example/users/carol/stamps/2" }],
    ["no author", { attributedTo: undefined }],
  ])("refuses a stamp with %s", (_label, overrides) => {
    expect(stampAuthorizes(stamp(overrides), expected)).toBe(false);
  });

  it("refuses a stamp served from a host other than its author's", () => {
    const uri = "https://evil.example/stamps/1";
    expect(stampAuthorizes(stamp({ id: uri }), { ...expected, uri })).toBe(false);
  });

  it("refuses what is not an object", () => {
    expect(stampAuthorizes("https://other.example/users/carol/stamps/1", expected)).toBe(false);
    expect(stampAuthorizes(null, expected)).toBe(false);
  });
});
