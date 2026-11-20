import { describe, expect, it } from "vite-plus/test";
import { Hostname } from "./hostname";
import { IsoInstant } from "./iso-instant";
import { WebfingerConfirmation } from "./webfinger-confirmation";

const now = IsoInstant.parse("2026-11-05T00:00:00.000Z")._unsafeUnwrap();

describe("WebfingerConfirmation.handleWrite", () => {
  it("stores the confirmed handle, confirmed now", () => {
    const handle = { username: "alice", domain: "example" };
    expect(
      WebfingerConfirmation.handleWrite(
        { kind: "Confirmed", handle },
        now,
        "FirstSeen",
      )._unsafeUnwrap(),
    ).toEqual({ kind: "Confirm", handle, webfingeredAt: now });
  });

  it("falls back to the URI's authority when the domain does not vouch for a cached actor", () => {
    expect(
      WebfingerConfirmation.handleWrite({ kind: "Mismatch" }, now, "Cached")._unsafeUnwrap(),
    ).toEqual({ kind: "UriAuthority" });
  });

  it("refuses a first-seen actor the domain does not vouch for, as check_webfinger! raises", () => {
    expect(
      WebfingerConfirmation.handleWrite({ kind: "Mismatch" }, now, "FirstSeen")._unsafeUnwrapErr(),
    ).toEqual({ kind: "WebfingerMismatch" });
  });

  it("keeps the row's handle when a lookup could not finish", () => {
    expect(
      WebfingerConfirmation.handleWrite({ kind: "Unavailable" }, now, "Cached")._unsafeUnwrap(),
    ).toEqual({ kind: "Keep" });
  });

  it("refuses an actor whose claimed account domain is refused", () => {
    const host = Hostname.ofAuthority("example");
    expect(
      WebfingerConfirmation.handleWrite(
        { kind: "Refused", host },
        now,
        "FirstSeen",
      )._unsafeUnwrapErr(),
    ).toEqual({ kind: "DomainRefused", host });
  });

  it("refuses an actor whose WebFinger names a username Mastodon would not store", () => {
    expect(
      WebfingerConfirmation.handleWrite(
        { kind: "UnsupportedUsername" },
        now,
        "FirstSeen",
      )._unsafeUnwrapErr(),
    ).toEqual({ kind: "UnsupportedUsername" });
  });
});
