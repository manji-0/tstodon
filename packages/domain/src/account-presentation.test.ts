import { describe, expect, it } from "vite-plus/test";
import { AccountPresentation } from "./account-presentation";
import { AccountStanding } from "./account-standing";

const suspended = { kind: "Suspended" } as const;
const silenced = { kind: "Silenced" } as const;

describe("AccountPresentation", () => {
  it("strips a suspended account and keeps a silenced one", () => {
    expect(AccountPresentation.ofLocal(suspended).kind).toBe("Suspended");
    expect(AccountPresentation.ofLocal(silenced).kind).toBe("Shown");
    expect(AccountPresentation.ofLocal(AccountStanding.inGoodStanding).kind).toBe("Shown");
  });

  it("hides a remote actor whose domain does not federate, whatever its standing", () => {
    for (const standing of [AccountStanding.inGoodStanding, suspended]) {
      expect(
        AccountPresentation.ofRemote({ federates: false, domainSuspended: false, standing }).kind,
      ).toBe("Hidden");
      expect(
        AccountPresentation.ofRemote({ federates: true, domainSuspended: true, standing }).kind,
      ).toBe("Hidden");
    }
    expect(
      AccountPresentation.ofRemote({ federates: true, domainSuspended: false, standing: suspended })
        .kind,
    ).toBe("Suspended");
  });

  it("counts only shown accounts as available", () => {
    expect(AccountPresentation.available({ kind: "Shown" })).toBe(true);
    expect(AccountPresentation.available({ kind: "Suspended" })).toBe(false);
    expect(AccountPresentation.available({ kind: "Hidden" })).toBe(false);
  });
});
