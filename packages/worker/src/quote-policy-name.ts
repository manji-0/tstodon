import { assertNever } from "@tstodon/core";
import type { LocalAccount, LocalNote, QuoteApprovalPolicy } from "@tstodon/domain";
import { findStatusQuotePolicy, type QuotePolicy } from "./quote-store";

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

/**
 * The policy a note federates in `interactionPolicy`: its stored one, else its
 * author's default. A note that is not public or unlisted is the author's
 * alone to quote, as Mastodon's `downgrade_quote_policy` keeps it.
 */
export const loadNoteQuotePolicy = async (
  db: D1Database,
  account: LocalAccount,
  note: LocalNote,
): Promise<QuotePolicy> => {
  if (note.visibility.kind !== "Public" && note.visibility.kind !== "Unlisted") {
    return "nobody";
  }
  const stored = await findStatusQuotePolicy(db, note.id);
  // An unreadable policy federates as the most restrictive one rather than fail the note.
  return stored.isErr() ? "nobody" : (stored.value ?? quotePolicyName(account.defaultQuotePolicy));
};
