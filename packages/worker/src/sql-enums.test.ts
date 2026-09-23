import { describe, expect, it } from "vitest";
import { QuoteApprovalPolicy, Visibility } from "@tstodon/domain";
import { quotePolicyFromSql, quotePolicySql, visibilitySql } from "./sql-enums";

describe("sql-enums", () => {
  it("round-trips visibility to Mastodon SQL strings", () => {
    expect(visibilitySql(Visibility.Public)).toBe("public");
    expect(visibilitySql(Visibility.Unlisted)).toBe("unlisted");
    expect(visibilitySql(Visibility.FollowersOnly)).toBe("private");
    expect(visibilitySql(Visibility.Direct)).toBe("direct");
  });

  it("maps quote approval policy both ways", () => {
    expect(quotePolicySql(QuoteApprovalPolicy.Public)).toBe("public");
    expect(quotePolicySql(QuoteApprovalPolicy.Followers)).toBe("followers");
    expect(quotePolicySql(QuoteApprovalPolicy.Nobody)).toBe("nobody");
    expect(quotePolicyFromSql("followers")).toEqual(QuoteApprovalPolicy.Followers);
    expect(quotePolicyFromSql("nobody")).toEqual(QuoteApprovalPolicy.Nobody);
    expect(quotePolicyFromSql("public")).toEqual(QuoteApprovalPolicy.Public);
    expect(quotePolicyFromSql("unknown")).toEqual(QuoteApprovalPolicy.Public);
  });
});
