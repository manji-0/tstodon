import { err } from "neverthrow";
import { findQuoteByActivityUri } from "../quote-store";
import { receiveFollowAnswer } from "./follow-answer";
import type { InboxHandler, RemoteDelivery } from "./handler";
import { receiveQuoteAnswer } from "./quote-answer";

/**
 * An `Accept` or `Reject` answers one of our quote requests or a follow, as
 * Mastodon's `Accept#perform` tries them; the request id tells them apart.
 */
export const receiveAnswer: InboxHandler<RemoteDelivery<"Accept" | "Reject">> = async (
  delivery,
) => {
  const quote = await findQuoteByActivityUri(delivery.env.DB, delivery.activity.object);
  if (quote.isErr()) {
    return err(quote.error);
  }
  return quote.value ? receiveQuoteAnswer(delivery, quote.value) : receiveFollowAnswer(delivery);
};
