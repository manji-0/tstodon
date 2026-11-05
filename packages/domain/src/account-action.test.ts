import { describe, expect, it } from "vite-plus/test";
import { AccountActionType } from "./account-action";

describe("AccountActionType", () => {
  it("parses Mastodon's action types only", () => {
    expect(AccountActionType.parse("suspend").isOk()).toBe(true);
    expect(AccountActionType.parse("delete").isErr()).toBe(true);
  });

  it("moderates a remote actor, which cannot be disabled", () => {
    expect(AccountActionType.remoteEffect("none")).toEqual({ kind: "Nothing" });
    expect(AccountActionType.remoteEffect("sensitive")).toEqual({
      kind: "Moderate",
      action: "sensitize",
    });
    expect(AccountActionType.remoteEffect("silence")).toEqual({
      kind: "Moderate",
      action: "silence",
    });
    expect(AccountActionType.remoteEffect("suspend")).toEqual({
      kind: "Moderate",
      action: "suspend",
    });
    expect(AccountActionType.remoteEffect("disable")).toEqual({ kind: "NotApplicable" });
  });
});
