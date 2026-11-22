import { describe, expect, it } from "vite-plus/test";
import { AccountStanding } from "./account-standing";

const good = AccountStanding.inGoodStanding;
const silenced: AccountStanding = { kind: "Silenced" };
const suspended: AccountStanding = { kind: "Suspended" };

describe("AccountStanding.stronger", () => {
  it("holds a suspension over a silence, and either over good standing", () => {
    expect(AccountStanding.stronger(good, silenced)).toEqual(silenced);
    expect(AccountStanding.stronger(silenced, good)).toEqual(silenced);
    expect(AccountStanding.stronger(silenced, suspended)).toEqual(suspended);
    expect(AccountStanding.stronger(suspended, silenced)).toEqual(suspended);
    expect(AccountStanding.stronger(good, good)).toEqual(good);
  });
});
