import { schemaResult } from "@tstodon/core";
import type { InstanceIdentity, QuoteState, RemoteStatusValue } from "@tstodon/domain";
import { z } from "zod";
import { JsonObjectSchema, refId } from "./activitypub-wire";
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
const parseJsonObject = schemaResult(JsonObjectSchema);

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

/**
 * A stamp as fetched from its own URI: none named (or one we may not fetch:
 * not http(s), or ours), a temporary failure, one that does not resolve
 * (4xx, refused host), or its document.
 */
export type StampFetch =
  | Readonly<{ kind: "None" }>
  | Readonly<{ kind: "Unavailable" }>
  | Readonly<{ kind: "Gone" }>
  | Readonly<{ kind: "Fetched"; uri: string; document: unknown }>;

/**
 * Fetch the stamp `uri` from its own URI, even when the note inlines it,
 * since the quoting server is not the stamp's author; Mastodon reads the
 * stamp URI the same way.
 */
export const fetchStamp = async (
  identity: InstanceIdentity,
  uri: string | undefined,
  options: FederatedFetchOptions,
): Promise<StampFetch> => {
  if (
    uri === undefined ||
    parseFederatedUrl(uri).isErr() ||
    uriHost(uri) === uriHost(identity.publicOrigin)
  ) {
    return { kind: "None" };
  }
  const fetched = await fetchActivityJson(identity, uri, options);
  if (fetched.isErr()) {
    return fetched.error.kind === "VerificationUnavailable"
      ? { kind: "Unavailable" }
      : { kind: "Gone" };
  }
  return { kind: "Fetched", uri, document: fetched.value };
};

/**
 * The quoted note a fetched stamp inlines as `interactionTarget`, with the
 * stamp's author, when the stamp is the one this quote names: served under
 * its own id on its author's host, typed `QuoteAuthorization`, approving the
 * quoting note for `quotedUri`. The inlined note is not trusted for that:
 * the caller stores it only when it is the stamp author's own note on the
 * stamp author's host, as Mastodon's `safe_prefetched_embed`.
 */
export const stampQuotedObject = (
  stamp: StampFetch,
  expected: Readonly<{ quotingUri: string; quotedUri: string }>,
): Readonly<{ object: Record<string, unknown>; authorUri: string }> | undefined => {
  if (stamp.kind !== "Fetched") {
    return undefined;
  }
  const parsed = parseStamp(stamp.document);
  if (parsed.isErr()) {
    return undefined;
  }
  const authorUri = refId(parsed.value.attributedTo);
  const types = typeof parsed.value.type === "string" ? [parsed.value.type] : parsed.value.type;
  const host = uriHost(stamp.uri);
  const target = parsed.value.interactionTarget;
  const object = parseJsonObject(target);
  if (
    authorUri === undefined ||
    parsed.value.id !== stamp.uri ||
    host === undefined ||
    host !== uriHost(authorUri) ||
    !types.includes("QuoteAuthorization") ||
    refId(parsed.value.interactingObject) !== expected.quotingUri ||
    refId(target) !== expected.quotedUri ||
    object.isErr()
  ) {
    return undefined;
  }
  return { object: object.value, authorUri };
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
 * the stamp is fetched with {@link fetchStamp}, unless `prefetched` already
 * holds that fetch. A stamp that verifies accepts the quote. A temporary
 * fetch failure, no stamp, a stamp URI that is not http(s) or is ours, or a
 * stamp that does not match leaves the quote pending; a stamp that does not
 * resolve (4xx, refused host) rejects it.
 */
export const verifyRemoteQuote = async (
  identity: InstanceIdentity,
  claim: RemoteQuoteClaim,
  options: FederatedFetchOptions,
  prefetched?: StampFetch,
): Promise<QuoteState> => {
  if (claim.quoted.actorUri === claim.quoting.actorUri) {
    return { kind: "Accepted", approval: { kind: "Implicit" } };
  }
  const stamp = prefetched ?? (await fetchStamp(identity, claim.approvalUri, options));
  switch (stamp.kind) {
    case "None":
    case "Unavailable":
      return { kind: "Pending" };
    case "Gone":
      return { kind: "Rejected" };
    case "Fetched":
      return stampAuthorizes(stamp.document, {
        uri: stamp.uri,
        quotingUri: claim.quoting.objectUri,
        quotedUri: claim.quoted.objectUri,
        quotedActorUri: claim.quoted.actorUri,
      })
        ? { kind: "Accepted", approval: { kind: "Stamp", uri: stamp.uri } }
        : { kind: "Pending" };
  }
};

/**
 * The state of a quote whose quoted note could not be fetched, as Mastodon's
 * `VerifyQuoteService` leaves a quote with no `quoted_status`: pending,
 * unless the stamp it names does not resolve, which rejects it.
 */
export const unresolvedQuoteState = (stamp: StampFetch): QuoteState =>
  stamp.kind === "Gone" ? { kind: "Rejected" } : { kind: "Pending" };
