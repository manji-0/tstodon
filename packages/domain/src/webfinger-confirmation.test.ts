import { describe, expect, it } from "vite-plus/test";
import { Hostname } from "./hostname";
import { IsoInstant } from "./iso-instant";
import { WebfingerConfirmation } from "./webfinger-confirmation";

const instant = (raw: string): IsoInstant => IsoInstant.parse(raw)._unsafeUnwrap();
const now = instant("2026-11-05T00:00:00.000Z");
const fromDocument = { username: "alice", domain: "social.example" };
const stored = {
  username: "alice",
  domain: "example",
  webfingeredAt: instant("2026-10-01T00:00:00.000Z"),
};

describe("WebfingerConfirmation.handleToCache", () => {
  it("takes the confirmed handle, confirmed now", () => {
    const handle = { username: "alice", domain: "example" };
    expect(
      WebfingerConfirmation.handleToCache(
        { kind: "Confirmed", handle },
        fromDocument,
        undefined,
        now,
      )._unsafeUnwrap(),
    ).toEqual({ ...handle, webfingeredAt: now });
  });

  it("falls back to the URI's authority, unconfirmed, when the domain does not vouch", () => {
    expect(
      WebfingerConfirmation.handleToCache(
        { kind: "Mismatch" },
        fromDocument,
        stored,
        now,
      )._unsafeUnwrap(),
    ).toEqual(fromDocument);
  });

  it.each(["Unavailable", "Unchecked"] as const)(
    "keeps the stored handle and when it was confirmed when %s, else the URI's authority",
    (kind) => {
      expect(
        WebfingerConfirmation.handleToCache({ kind }, fromDocument, stored, now)._unsafeUnwrap(),
      ).toEqual(stored);
      expect(
        WebfingerConfirmation.handleToCache({ kind }, fromDocument, undefined, now)._unsafeUnwrap(),
      ).toEqual(fromDocument);
    },
  );

  it("refuses an actor whose claimed account domain is refused", () => {
    const host = Hostname.ofAuthority("example");
    expect(
      WebfingerConfirmation.handleToCache(
        { kind: "Refused", host },
        fromDocument,
        stored,
        now,
      )._unsafeUnwrapErr(),
    ).toEqual({ kind: "DomainRefused", host });
  });
});
