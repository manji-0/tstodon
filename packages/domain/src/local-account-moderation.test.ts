import { describe, expect, it } from "vite-plus/test";
import { LocalAccountModeration } from "./local-account-moderation";

const start = LocalAccountModeration.inGoodStanding;

describe("LocalAccountModeration", () => {
  it("keeps a suspension when the account is silenced or unsilenced", () => {
    const suspended = LocalAccountModeration.apply(start, "suspend");
    expect(LocalAccountModeration.apply(suspended, "silence")).toEqual(suspended);
    expect(LocalAccountModeration.apply(suspended, "unsilence")).toEqual(suspended);
    expect(LocalAccountModeration.apply(suspended, "unsuspend")).toEqual(start);
  });

  it("changes login, approval, and the sensitive mark apart from the standing", () => {
    const silenced = LocalAccountModeration.apply(
      LocalAccountModeration.awaitingApproval,
      "silence",
    );
    const disabled = LocalAccountModeration.apply(
      LocalAccountModeration.apply(silenced, "disable"),
      "sensitize",
    );
    expect(disabled).toEqual({
      standing: { kind: "Silenced" },
      sensitized: true,
      login: { kind: "Disabled" },
      approval: { kind: "Pending" },
    });
    expect(LocalAccountModeration.apply(disabled, "approve").approval).toEqual({
      kind: "Approved",
    });
    expect(LocalAccountModeration.apply(disabled, "enable").standing).toEqual({
      kind: "Silenced",
    });
  });

  it("bars a suspended account or a disabled login, not a silenced or pending one", () => {
    expect(LocalAccountModeration.isBarred(start)).toBe(false);
    expect(LocalAccountModeration.isBarred(LocalAccountModeration.awaitingApproval)).toBe(false);
    expect(LocalAccountModeration.isBarred(LocalAccountModeration.apply(start, "silence"))).toBe(
      false,
    );
    expect(LocalAccountModeration.isBarred(LocalAccountModeration.apply(start, "suspend"))).toBe(
      true,
    );
    expect(LocalAccountModeration.isBarred(LocalAccountModeration.apply(start, "disable"))).toBe(
      true,
    );
  });

  it("names the remote counterpart of standing and media actions only", () => {
    expect(LocalAccountModeration.remoteCounterpart("suspend")).toBe("suspend");
    expect(LocalAccountModeration.remoteCounterpart("unsensitize")).toBe("unsensitize");
    expect(LocalAccountModeration.remoteCounterpart("disable")).toBeUndefined();
    expect(LocalAccountModeration.remoteCounterpart("approve")).toBeUndefined();
  });
});
