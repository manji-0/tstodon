import { assertNever } from "@tstodon/core";
import type { QuoteApprovalPolicy } from "@tstodon/domain";
import type { QuotePolicy } from "./quote-store";

/** The account-level default policy as its API name. */
export const quotePolicyName = (policy: QuoteApprovalPolicy): QuotePolicy => {
  switch (policy.kind) {
    case "Public":
      return "public";
    case "Followers":
      return "followers";
    case "Nobody":
      return "nobody";
    default:
      return assertNever(policy);
  }
};
