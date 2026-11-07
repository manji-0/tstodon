import { describe, expect, it } from "vite-plus/test";
import { IsoInstant } from "./iso-instant";
import { Quote, QuotedTarget, type QuoteState } from "./quote";
import { StatusId } from "./status-id";

const quoteIn = (state: QuoteState): Quote => {
  const quoting = StatusId.parse("200");
  const quoted = StatusId.parse("100");
  const createdAt = IsoInstant.parse("2026-11-01T00:00:00.000Z");
  if (quoting.isErr() || quoted.isErr() || createdAt.isErr()) {
    throw new Error("invalid fixture");
  }
  return {
    id: "q1",
    quoting: { kind: "LocalStatus", statusId: quoting.value },
    quoted: { kind: "RemoteStatus", statusId: quoted.value },
    state,
    legacy: false,
    activityUri: "https://local.example/users/alice/statuses/200/quote_request",
    createdAt: createdAt.value,
  };
};

const stamp = { kind: "Stamp", uri: "https://remote.example/quote_authorizations/1" } as const;
const accepted: QuoteState = { kind: "Accepted", approval: stamp };

describe("Quote", () => {
  it("accepts a pending quote with its approval", () => {
    const result = Quote.accept(quoteIn({ kind: "Pending" }), stamp);
    expect(result._unsafeUnwrap().state).toEqual(accepted);
  });

  it.each<QuoteState>([accepted, { kind: "Rejected" }, { kind: "Revoked" }, { kind: "Deleted" }])(
    "refuses to accept a quote in $kind",
    (state) => {
      expect(Quote.accept(quoteIn(state), stamp)._unsafeUnwrapErr()).toEqual({
        kind: "NotPending",
      });
    },
  );

  it("rejects an accepted quote as revoked", () => {
    expect(Quote.reject(quoteIn(accepted)).state).toEqual({ kind: "Revoked" });
  });

  it("rejects a pending quote", () => {
    expect(Quote.reject(quoteIn({ kind: "Pending" })).state).toEqual({ kind: "Rejected" });
  });

  it("leaves a revoked quote revoked when rejected", () => {
    expect(Quote.reject(quoteIn({ kind: "Revoked" })).state).toEqual({ kind: "Revoked" });
  });

  it("revokes an accepted quote", () => {
    expect(Quote.revoke(quoteIn(accepted))._unsafeUnwrap().state).toEqual({ kind: "Revoked" });
  });

  it.each<QuoteState>([{ kind: "Pending" }, { kind: "Rejected" }, { kind: "Revoked" }])(
    "refuses to revoke a quote in $kind",
    (state) => {
      expect(Quote.revoke(quoteIn(state))._unsafeUnwrapErr()).toEqual({ kind: "NotAccepted" });
    },
  );

  it("shows a legacy quote only once it is accepted, as Mastodon's acceptable?", () => {
    expect(Quote.isShown({ ...quoteIn({ kind: "Pending" }), legacy: true })).toBe(false);
    expect(Quote.isShown({ ...quoteIn(accepted), legacy: true })).toBe(true);
    expect(Quote.isShown(quoteIn({ kind: "Pending" }))).toBe(true);
  });

  it("parses an unresolved quoted note by its URI", () => {
    const quote = Quote.parse({
      ...quoteIn({ kind: "Pending" }),
      quoted: QuotedTarget.unresolved("https://remote.example/notes/9"),
    });
    expect(quote._unsafeUnwrap().quoted).toEqual({
      kind: "Unresolved",
      uri: "https://remote.example/notes/9",
    });
    expect(QuotedTarget.parse({ kind: "Unresolved", uri: "not a uri" }).isErr()).toBe(true);
  });

  it("compares quoted targets by status or by unresolved URI", () => {
    const unresolved = QuotedTarget.unresolved("https://remote.example/notes/9");
    const remote = quoteIn({ kind: "Pending" }).quoted;
    expect(QuotedTarget.equals(unresolved, unresolved)).toBe(true);
    expect(QuotedTarget.equals(unresolved, remote)).toBe(false);
    expect(QuotedTarget.equals(remote, { ...remote })).toBe(true);
  });
});
