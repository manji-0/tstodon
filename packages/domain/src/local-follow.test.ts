import { describe, expect, it } from "vitest";
import { LocalFollow } from "./local-follow";

describe("LocalFollow", () => {
  it("starts locked targets as Pending and unlocked as Accepted", () => {
    expect(LocalFollow.initial(true)).toEqual(LocalFollow.Pending);
    expect(LocalFollow.initial(false)).toEqual(LocalFollow.Accepted);
  });

  it("authorize always yields Accepted", () => {
    expect(LocalFollow.authorize(LocalFollow.Pending)).toEqual(LocalFollow.Accepted);
    expect(LocalFollow.authorize(LocalFollow.Accepted)).toEqual(LocalFollow.Accepted);
  });

  it("existsAfterReject only for Accepted follows", () => {
    expect(LocalFollow.existsAfterReject(LocalFollow.Pending)).toBe(false);
    expect(LocalFollow.existsAfterReject(LocalFollow.Accepted)).toBe(true);
  });

  it("maps notification kind from follow state", () => {
    expect(LocalFollow.notificationKind(LocalFollow.Pending)).toBe("follow_request");
    expect(LocalFollow.notificationKind(LocalFollow.Accepted)).toBe("follow");
  });

  it("parses kind-discriminated variants", () => {
    const pending = LocalFollow.parse({ kind: "Pending" });
    expect(pending.isOk()).toBe(true);
    const rejected = LocalFollow.parse({ kind: "Rejected" });
    expect(rejected.isErr()).toBe(true);
  });
});
