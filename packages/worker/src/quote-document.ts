import type { QuoteState } from "@tstodon/domain";

/** Mastodon's `quote.state` for a quote that is not accepted. */
const QUOTE_STATE_NAMES = {
  Pending: "pending",
  Rejected: "rejected",
  Revoked: "revoked",
  Deleted: "deleted",
} as const satisfies Record<Exclude<QuoteState["kind"], "Accepted">, string>;

/**
 * A quoted status as rendered for the viewer: `Unauthorized` when the viewer
 * may not see it or its author is not shown, `undefined` when it is gone.
 */
export type QuotedDocument = Record<string, unknown> | "Unauthorized" | undefined;

/** What the viewer is shown of an accepted quote's status, as {@link QuotedDocument} without the document. */
export type QuotedStatusAccess = "Shown" | "Unauthorized" | "Gone";

/** Mastodon's `quote.state` for an accepted quote, as `StatusFilter#filter_state_for_quote` amends it. */
const ACCEPTED_STATE_NAMES = {
  Shown: "accepted",
  Unauthorized: "unauthorized",
  Gone: "deleted",
} as const satisfies Record<QuotedStatusAccess, string>;

/**
 * A status's `quote`, as Mastodon's `BaseQuoteSerializer`: only an accepted
 * quote shows its status, and only while the status is there to show.
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
    : { state: ACCEPTED_STATE_NAMES.Shown, quoted_status: document };
};

/**
 * The `quote` of a status shown inside another's quote, as Mastodon's
 * `ShallowQuoteSerializer`: the quoted status by id only, so statuses that
 * quote each other render once.
 */
export const mastodonShallowQuote = (
  state: QuoteState,
  quotedStatusId: string,
  access: () => QuotedStatusAccess,
): Record<string, unknown> => {
  if (state.kind !== "Accepted") {
    return { state: QUOTE_STATE_NAMES[state.kind], quoted_status_id: null };
  }
  const shown = access();
  return {
    state: ACCEPTED_STATE_NAMES[shown],
    quoted_status_id: shown === "Shown" ? quotedStatusId : null,
  };
};
