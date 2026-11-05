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
    ).toEqual({ kind: "Confirm", handle, webfingeredAt: now });
  });

  it("falls back to the URI's authority when the domain does not vouch", () => {
    expect(WebfingerConfirmation.handleWrite({ kind: "Mismatch" }, now)._unsafeUnwrap()).toEqual({
      kind: "UriAuthority",
    });
  });

  it("keeps the row's handle when a lookup could not finish", () => {
    expect(WebfingerConfirmation.handleWrite({ kind: "Unavailable" }, now)._unsafeUnwrap()).toEqual(
      { kind: "Keep" },
    );
  });

  it("refuses an actor whose claimed account domain is refused", () => {
    const host = Hostname.ofAuthority("example");
    expect(
      WebfingerConfirmation.handleWrite({ kind: "Refused", host }, now)._unsafeUnwrapErr(),
    ).toEqual({ kind: "DomainRefused", host });
  });
});
