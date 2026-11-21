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

  it.each(["CachedUnderOtherHandle", "FirstSeen"] as const)(
    "refuses a %s actor the domain does not vouch for, as check_webfinger! raises",
    (record) => {
      expect(
        WebfingerConfirmation.handleWrite({ kind: "Mismatch" }, now, record)._unsafeUnwrapErr(),
      ).toEqual({ kind: "WebfingerMismatch" });
    },
  );

  it("keeps the handle an actor is cached under and claims, which Mastodon does not ask WebFinger for", () => {
    expect(
      WebfingerConfirmation.handleWrite(
        { kind: "Mismatch" },
        now,
        "CachedUnderClaimedHandle",
      )._unsafeUnwrap(),
    ).toEqual({ kind: "Keep" });
  });

  it.each(["CachedUnderClaimedHandle", "CachedUnderOtherHandle"] as const)(
    "keeps the row's handle when a lookup could not finish for a %s actor",
    (record) => {
      expect(
        WebfingerConfirmation.handleWrite({ kind: "Unavailable" }, now, record)._unsafeUnwrap(),
      ).toEqual({ kind: "Keep" });
    },
  );

  it("stores no first-seen actor while a lookup cannot finish, so a later one asks again", () => {
    expect(
      WebfingerConfirmation.handleWrite(
        { kind: "Unavailable" },
        now,
        "FirstSeen",
      )._unsafeUnwrapErr(),
    ).toEqual({ kind: "WebfingerUnavailable" });
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
