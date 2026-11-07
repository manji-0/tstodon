import type { QuoteState } from "@tstodon/domain";

/** Mastodon's `quote.state` for a quote that is not accepted. */
const QUOTE_STATE_NAMES = {
  Pending: "pending",
  Rejected: "rejected",
  Revoked: "revoked",
  Deleted: "deleted",
} as const satisfies Record<Exclude<QuoteState["kind"], "Accepted">, string>;

/**
 * What the viewer is shown of an accepted quote's status, as Mastodon's
 * `StatusFilter#filter_state_for_quote` decides it: the status itself, the
 * status under a label for the viewer's block, domain block or mute of its
 * author, nothing when the viewer may not see it (`Unauthorized`), or nothing
 * when it is gone.
 */
export type QuotedStatusAccess =
  | "Shown"
  | "BlockedDomain"
  | "BlockedAccount"
  | "MutedAccount"
  | "Unauthorized"
  | "Gone";

/** An access under which the quoted status is still rendered. */
export type QuotedStatusShown = Exclude<QuotedStatusAccess, "Unauthorized" | "Gone">;

export const isQuotedStatusShown = (access: QuotedStatusAccess): access is QuotedStatusShown =>
  access !== "Unauthorized" && access !== "Gone";

/** A quoted status as rendered for the viewer, with the access it is shown under. */
export type QuotedDocument =
  | Readonly<{ access: QuotedStatusShown; document: Record<string, unknown> }>
  | "Unauthorized"
  | undefined;

/** Mastodon's `quote.state` for an accepted quote, as `StatusFilter#filter_state_for_quote` amends it. */
const ACCEPTED_STATE_NAMES = {
  Shown: "accepted",
  BlockedDomain: "blocked_domain",
  BlockedAccount: "blocked_account",
  MutedAccount: "muted_account",
  Unauthorized: "unauthorized",
  Gone: "deleted",
} as const satisfies Record<QuotedStatusAccess, string>;

/**
 * A status's `quote`, as Mastodon's `BaseQuoteSerializer`: only an accepted
 * quote shows its status, and only while the status is there and the viewer
 * may see it.
 */
export const mastodonQuote = (
  state: QuoteState,
  quoted: () => QuotedDocument,
): Record<string, unknown> => {
  if (state.kind !== "Accepted") {
    return { state: QUOTE_STATE_NAMES[state.kind], quoted_status: null };
  }
  const document = quoted();
  if (document === undefined) {
    return { state: ACCEPTED_STATE_NAMES.Gone, quoted_status: null };
  }
  return document === "Unauthorized"
    ? { state: ACCEPTED_STATE_NAMES.Unauthorized, quoted_status: null }
    : { state: ACCEPTED_STATE_NAMES[document.access], quoted_status: document.document };
};

/**
 * The `quote` of a status shown inside another's quote, as Mastodon's
 * `ShallowQuoteSerializer`: the quoted status by id only, so statuses that
 * quote each other render once.
 */
export const mastodonShallowQuote = (
  state: QuoteState,
  quotedStatusId: string | null,
  access: () => QuotedStatusAccess,
): Record<string, unknown> => {
  if (state.kind !== "Accepted") {
    return { state: QUOTE_STATE_NAMES[state.kind], quoted_status_id: null };
  }
  const shown = access();
  return {
    state: ACCEPTED_STATE_NAMES[shown],
    quoted_status_id: isQuotedStatusShown(shown) ? quotedStatusId : null,
  };
};
