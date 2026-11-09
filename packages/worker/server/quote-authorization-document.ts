import {
  ACTIVITY_STREAMS,
  type ApActivityDocumentOf,
  type ApQuoteAuthorizationDocumentJSON,
  type ApQuoteAuthorizationJSON,
  PUBLIC_COLLECTION,
} from "@tstodon/api/activitypub";
import type { ActivityObjectRef } from "./activitypub";

/**
 * A FEP-044f `QuoteAuthorization`: the quoted author's stamp approving one
 * status quoting theirs, by URI.
 */
export type QuoteAuthorization = Omit<ApQuoteAuthorizationJSON, "type">;

/** The stamp a local quoted author mints for a quote, as Mastodon's `approval_uri_for`. */
export const quoteAuthorizationUri = (quotedAuthorUri: string, quoteId: string): string =>
  `${quotedAuthorUri}/quote_authorizations/${quoteId}`;

/** The stamp of a quote of a local status, approved by its author. */
export const localQuoteAuthorization = (
  quoted: ActivityObjectRef,
  quoteId: string,
  interactingObject: string,
): QuoteAuthorization => ({
  id: quoteAuthorizationUri(quoted.authorUri, quoteId),
  attributedTo: quoted.authorUri,
  interactingObject,
  interactionTarget: quoted.uri,
});

/** Mastodon's `quote_authorizations` context extension. */
const context: ApQuoteAuthorizationDocumentJSON["@context"] = [
  ACTIVITY_STREAMS,
  {
    gts: "https://gotosocial.org/ns#",
    QuoteAuthorization: "https://w3id.org/fep/044f#QuoteAuthorization",
    interactingObject: { "@id": "gts:interactingObject", "@type": "@id" },
    interactionTarget: { "@id": "gts:interactionTarget", "@type": "@id" },
  },
];

const stampObject = (stamp: QuoteAuthorization): ApQuoteAuthorizationJSON => ({
  id: stamp.id,
  type: "QuoteAuthorization",
  attributedTo: stamp.attributedTo,
  interactingObject: stamp.interactingObject,
  interactionTarget: stamp.interactionTarget,
});

/** The stamp document, as Mastodon's `QuoteAuthorizationSerializer`. */
export const quoteAuthorizationDocument = (
  stamp: QuoteAuthorization,
): ApQuoteAuthorizationDocumentJSON => ({
  "@context": context,
  ...stampObject(stamp),
});

/** Withdraws a stamp, as Mastodon's `DeleteQuoteAuthorizationSerializer`. */
export const quoteAuthorizationDeleteActivity = (
  stamp: QuoteAuthorization,
): ApActivityDocumentOf<"Delete"> => ({
  "@context": context,
  id: `${stamp.id}#delete`,
  type: "Delete",
  actor: stamp.attributedTo,
  to: [PUBLIC_COLLECTION],
  object: stampObject(stamp),
});
