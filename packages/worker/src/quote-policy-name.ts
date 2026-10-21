import type { LocalAccount } from "@tstodon/domain";
import type { QuotePolicy } from "./quote-store";

/** The account-level default policy as its API name. */
export const quotePolicyName = (policy: LocalAccount["defaultQuotePolicy"]): QuotePolicy => {
  switch (policy.kind) {
    case "Public":
      return "public";
    case "Followers":
      return "followers";
    default:
      return "nobody";
  }
};
