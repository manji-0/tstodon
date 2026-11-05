import { describe, expect, it } from "vite-plus/test";
import { Hostname } from "./hostname";
import { WebfingerConfirmation } from "./webfinger-confirmation";

const fromDocument = { username: "alice", domain: "social.example" };
const stored = { username: "alice", domain: "example" };

describe("WebfingerConfirmation.handleToCache", () => {
  it("takes the confirmed handle", () => {
    const handle = { username: "alice", domain: "example" };
    expect(
      WebfingerConfirmation.handleToCache(
        { kind: "Confirmed", handle },
        fromDocument,
        undefined,
      )._unsafeUnwrap(),
    ).toEqual(handle);
  });

  it("falls back to the URI's authority on a definite answer for another actor", () => {
    expect(
      WebfingerConfirmation.handleToCache(
        { kind: "Mismatch" },
        fromDocument,
        stored,
      )._unsafeUnwrap(),
    ).toEqual(fromDocument);
  });

  it("keeps the stored handle when a lookup fails, else the URI's authority", () => {
    expect(
      WebfingerConfirmation.handleToCache(
        { kind: "Unavailable" },
        fromDocument,
        stored,
      )._unsafeUnwrap(),
    ).toEqual(stored);
    expect(
      WebfingerConfirmation.handleToCache(
        { kind: "Unavailable" },
        fromDocument,
        undefined,
      )._unsafeUnwrap(),
    ).toEqual(fromDocument);
  });

  it("refuses an actor whose claimed account domain is refused", () => {
    const host = Hostname.ofAuthority("example");
    expect(
      WebfingerConfirmation.handleToCache(
        { kind: "Refused", host },
        fromDocument,
        stored,
      )._unsafeUnwrapErr(),
    ).toEqual({ kind: "DomainRefused", host });
  });
});
