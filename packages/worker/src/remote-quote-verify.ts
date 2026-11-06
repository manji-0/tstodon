import { schemaResult } from "@tstodon/core";
import type { InstanceIdentity, QuoteState, RemoteStatusValue } from "@tstodon/domain";
import { z } from "zod";
import { refId } from "./activitypub-wire";
import {
  fetchActivityJson,
  type FederatedFetchOptions,
  parseFederatedUrl,
} from "./federated-fetch";

/** What a `QuoteAuthorization` must say to approve one quote. */
export type StampExpectation = Readonly<{
  uri: string;
  quotingUri: string;
  quotedUri: string;
  quotedActorUri: string;
}>;

const StampSchema = z.object({
  id: z.string().min(1),
  type: z.union([z.string(), z.array(z.string())]),
  attributedTo: z.unknown(),
  interactingObject: z.unknown(),
  interactionTarget: z.unknown(),
});

const parseStamp = schemaResult(StampSchema);

const uriHost = (uri: string | undefined): string | undefined => {
  try {
    return uri === undefined ? undefined : new URL(uri).host.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * Whether `document` is the stamp `expected.uri` approving this quote, as
 * Mastodon's `VerifyQuoteService`: served under its own id, on its author's
 * host, typed `QuoteAuthorization`, naming the quoting note, the quoted note
 * and the quoted author.
 */
export const stampAuthorizes = (document: unknown, expected: StampExpectation): boolean => {
  const stamp = parseStamp(document);
  if (stamp.isErr()) {
    return false;
  }
  const attributedTo = refId(stamp.value.attributedTo);
  const types = typeof stamp.value.type === "string" ? [stamp.value.type] : stamp.value.type;
  const host = uriHost(expected.uri);
  return (
    stamp.value.id === expected.uri &&
    host !== undefined &&
    host === uriHost(attributedTo) &&
    types.includes("QuoteAuthorization") &&
    refId(stamp.value.interactingObject) === expected.quotingUri &&
    refId(stamp.value.interactionTarget) === expected.quotedUri &&
    attributedTo === expected.quotedActorUri
  );
};

/** A remote note quoting another cached remote note, with the stamp it names. */
export type RemoteQuoteClaim = Readonly<{
  quoting: RemoteStatusValue;
  quoted: RemoteStatusValue;
  approvalUri: string | undefined;
}>;

/**
 * The state of a quote between remote notes, as Mastodon's
 * `VerifyQuoteService`. A self-quote is accepted without a stamp. Otherwise
 * the stamp is fetched from its own URI, even when the note inlines it, since
 * the quoting server is not the stamp's author. A stamp that verifies
 * accepts the quote. A temporary fetch failure, no stamp, a stamp URI that is
 * not http(s) or is ours, or a stamp that does not match leaves the quote
 * pending; a stamp that does not resolve (4xx, refused host) rejects it.
 */
export const verifyRemoteQuote = async (
  identity: InstanceIdentity,
  claim: RemoteQuoteClaim,
  options: FederatedFetchOptions,
): Promise<QuoteState> => {
  if (claim.quoted.actorUri === claim.quoting.actorUri) {
    return { kind: "Accepted", approval: { kind: "Implicit" } };
  }
  const uri = claim.approvalUri;
  if (
    uri === undefined ||
    parseFederatedUrl(uri).isErr() ||
    uriHost(uri) === uriHost(identity.publicOrigin)
  ) {
    return { kind: "Pending" };
  }
  const fetched = await fetchActivityJson(identity, uri, options);
  if (fetched.isErr()) {
    return fetched.error.kind === "VerificationUnavailable"
      ? { kind: "Pending" }
      : { kind: "Rejected" };
  }
  return stampAuthorizes(fetched.value, {
    uri,
    quotingUri: claim.quoting.objectUri,
    quotedUri: claim.quoted.objectUri,
    quotedActorUri: claim.quoted.actorUri,
  })
    ? { kind: "Accepted", approval: { kind: "Stamp", uri } }
    : { kind: "Pending" };
};
