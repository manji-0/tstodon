import type { ActivityObjectRef } from "./activitypub";

/**
 * A FEP-044f `QuoteAuthorization`: the quoted author's stamp approving one
 * status quoting theirs, by URI.
 */
export type QuoteAuthorization = Readonly<{
  id: string;
  attributedTo: string;
  interactingObject: string;
  interactionTarget: string;
}>;

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
const context = [
  "https://www.w3.org/ns/activitystreams",
  {
    gts: "https://gotosocial.org/ns#",
    QuoteAuthorization: "https://w3id.org/fep/044f#QuoteAuthorization",
    interactingObject: { "@id": "gts:interactingObject", "@type": "@id" },
    interactionTarget: { "@id": "gts:interactionTarget", "@type": "@id" },
  },
];

const stampObject = (stamp: QuoteAuthorization): Record<string, unknown> => ({
  id: stamp.id,
  type: "QuoteAuthorization",
  attributedTo: stamp.attributedTo,
  interactingObject: stamp.interactingObject,
  interactionTarget: stamp.interactionTarget,
});

/** The stamp document, as Mastodon's `QuoteAuthorizationSerializer`. */
export const quoteAuthorizationDocument = (stamp: QuoteAuthorization): Record<string, unknown> => ({
  "@context": context,
  ...stampObject(stamp),
});

/** Withdraws a stamp, as Mastodon's `DeleteQuoteAuthorizationSerializer`. */
export const quoteAuthorizationDeleteActivity = (
  stamp: QuoteAuthorization,
): Record<string, unknown> => ({
  "@context": context,
  id: `${stamp.id}#delete`,
  type: "Delete",
  actor: stamp.attributedTo,
  to: ["https://www.w3.org/ns/activitystreams#Public"],
  object: stampObject(stamp),
});
