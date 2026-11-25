import { err, ok } from "neverthrow";
import { receiveFeatureAnswer } from "./feature-answer";
import { findQuoteByActivityUri } from "../quote-store";
import { receiveFollowAnswer } from "./follow-answer";
import type { InboxHandler, RemoteDelivery } from "./handler";
import { receiveQuoteAnswer } from "./quote-answer";

/**
 * An `Accept` or `Reject` answers one of our feature requests, quote requests or a follow, as
 * Mastodon's `Accept#perform` tries them; the request id tells them apart.
 */
export const receiveAnswer: InboxHandler<RemoteDelivery<"Accept" | "Reject">> = async (
  delivery,
) => {
  // As `Accept#perform` and `Reject#perform`, a feature request first.
  const featured = await receiveFeatureAnswer(delivery);
  if (featured.isErr()) {
    return err(featured.error);
  }
  if (featured.value) {
    return ok(undefined);
  }
  const quote = await findQuoteByActivityUri(delivery.env.DB, delivery.activity.object);
  if (quote.isErr()) {
    return err(quote.error);
  }
  return quote.value ? receiveQuoteAnswer(delivery, quote.value) : receiveFollowAnswer(delivery);
};
