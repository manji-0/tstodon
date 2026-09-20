import { assertNever } from "@tstodon/core";
import { QuoteApprovalPolicy, Visibility } from "@tstodon/domain";

export const visibilitySql = (visibility: Visibility): string =>
  Visibility.toMastodon(visibility);

export const quotePolicySql = (policy: QuoteApprovalPolicy): string => {
  switch (policy.kind) {
    case "Followers":
      return "followers";
    case "Nobody":
      return "nobody";
    case "Public":
      return "public";
    default:
      return assertNever(policy);
  }
};

export const quotePolicyFromSql = (raw: string): QuoteApprovalPolicy => {
  if (raw === "followers") {
    return QuoteApprovalPolicy.Followers;
  }
  if (raw === "nobody") {
    return QuoteApprovalPolicy.Nobody;
  }
  return QuoteApprovalPolicy.Public;
};
