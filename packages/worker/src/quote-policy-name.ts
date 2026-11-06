import { assertNever } from "@tstodon/core";
import {
  type LocalAccount,
  type LocalNote,
  type QuoteApprovalPolicy,
  QuoteInteractionPolicy,
} from "@tstodon/domain";
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
 * The policy a note goes by: `stored`, else its author's default. A note
 * that is not public or unlisted is the author's alone to quote, as
 * Mastodon's `downgrade_quote_policy` keeps it.
 */
export const noteQuotePolicy = (
  account: LocalAccount,
  note: LocalNote,
  stored: QuotePolicy | undefined,
): QuotePolicy =>
  note.visibility.kind !== "Public" && note.visibility.kind !== "Unlisted"
    ? "nobody"
    : (stored ?? quotePolicyName(account.defaultQuotePolicy));

/** A local note's policy as the audiences it lets quote, every one automatic here. */
export const quoteInteractionPolicy = (policy: QuotePolicy): QuoteInteractionPolicy =>
  policy === "nobody" ? QuoteInteractionPolicy.none : { automatic: [policy], manual: [] };

/** {@link noteQuotePolicy} with the stored policy read; an unreadable one is `nobody`. */
export const loadNoteQuotePolicy = async (
  db: D1Database,
  account: LocalAccount,
  note: LocalNote,
): Promise<QuotePolicy> => {
  const stored = await findStatusQuotePolicy(db, note.id);
  return stored.isErr() ? "nobody" : noteQuotePolicy(account, note, stored.value);
};
