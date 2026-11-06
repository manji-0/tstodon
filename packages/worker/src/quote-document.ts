import type { QuoteState } from "@tstodon/domain";

/** Mastodon's `quote.state` for a quote that is not accepted. */
const QUOTE_STATE_NAMES = {
  Pending: "pending",
  Rejected: "rejected",
  Revoked: "revoked",
  Deleted: "deleted",
} as const satisfies Record<Exclude<QuoteState["kind"], "Accepted">, string>;

/**
 * A quoted status as rendered for the viewer: `Unauthorized` when its author
 * is not shown, `undefined` when it is gone.
 */
export type QuotedDocument = Record<string, unknown> | "Unauthorized" | undefined;

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
    return { state: "deleted", quoted_status: null };
  }
  return document === "Unauthorized"
    ? { state: "unauthorized", quoted_status: null }
    : { state: "accepted", quoted_status: document };
};

/**
 * The `quote` of a status shown inside another's quote, as Mastodon's
 * `ShallowQuoteSerializer`: the quoted status by id only, so statuses that
 * quote each other render once.
 */
export const mastodonShallowQuote = (
  state: QuoteState,
  quotedStatusId: string,
): Record<string, unknown> =>
  state.kind === "Accepted"
    ? { state: "accepted", quoted_status_id: quotedStatusId }
    : { state: QUOTE_STATE_NAMES[state.kind], quoted_status_id: null };
