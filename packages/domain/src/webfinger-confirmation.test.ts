import { describe, expect, it } from "vite-plus/test";
import { Hostname } from "./hostname";
import { IsoInstant } from "./iso-instant";
import { WebfingerConfirmation } from "./webfinger-confirmation";

const now = IsoInstant.parse("2026-11-05T00:00:00.000Z")._unsafeUnwrap();

describe("WebfingerConfirmation.handleWrite", () => {
  it("stores the confirmed handle, confirmed now", () => {
    const handle = { username: "alice", domain: "example" };
    expect(
      WebfingerConfirmation.handleWrite({ kind: "Confirmed", handle }, now)._unsafeUnwrap(),
    ).toEqual({ handle, webfingeredAt: now });
  });

  it("writes nothing for an actor the domain does not vouch for, as check_webfinger! raises", () => {
    expect(WebfingerConfirmation.handleWrite({ kind: "Mismatch" }, now)._unsafeUnwrapErr()).toEqual(
      { kind: "WebfingerMismatch" },
    );
  });

  it("writes nothing while a lookup cannot finish, so a later request asks again", () => {
    expect(
      WebfingerConfirmation.handleWrite({ kind: "Unavailable" }, now)._unsafeUnwrapErr(),
    ).toEqual({ kind: "WebfingerUnavailable" });
  });

  it("refuses an actor whose claimed account domain is refused", () => {
    const host = Hostname.ofAuthority("example");
    expect(
      WebfingerConfirmation.handleWrite({ kind: "Refused", host }, now)._unsafeUnwrapErr(),
    ).toEqual({ kind: "DomainRefused", host });
  });

  it("refuses an actor whose WebFinger names a username Mastodon would not store", () => {
    expect(
      WebfingerConfirmation.handleWrite({ kind: "UnsupportedUsername" }, now)._unsafeUnwrapErr(),
    ).toEqual({ kind: "UnsupportedUsername" });
  });
});
