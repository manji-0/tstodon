import { schemaResult, type SensitiveValue } from "@tstodon/core";
import jsonld from "jsonld";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { importRsaPrivateKey, importRsaPublicKey } from "./http-signature";
import { JSONLD_CONTEXTS, MASTODON_FULL_CONTEXT } from "./jsonld-contexts";

/**
 * Linked Data Signatures (`RsaSignature2017`), as Mastodon's
 * `ActivityPub::LinkedDataSignature`: an RSA-SHA256 signature over the
 * URDNA2015 canonical form of the signature's options and of the document.
 * Another server checks one when it is handed an activity by someone other
 * than its actor (a forward), so the actor's own signature vouches for it.
 */

export const LD_SIGNATURE_TYPE = "RsaSignature2017" as const;
const IDENTITY_CONTEXT = "https://w3id.org/identity/v1";
const SECURITY_CONTEXT = "https://w3id.org/security/v1";
/** Mastodon's `sign!` default (`expires_in: 2.days`). */
const SIGNATURE_LIFETIME_MS = 2 * 24 * 60 * 60 * 1000;
/** Mastodon's `JsonLdHelper::UNSUPPORTED_JSONLD_KEYWORDS`. */
const UNSUPPORTED_KEYWORDS = new Set(["@graph", "@included", "@reverse"]);
/** Mastodon's `check_jsonld_limits!` budget: the most values a document may hold. */
const JSONLD_NODE_BUDGET = 1_000;

export type LdSignatureRefusal =
  /** No `signature` object. */
  | Readonly<{ kind: "Unsigned" }>
  /** Not an `RsaSignature2017`, or one without its fields. */
  | Readonly<{ kind: "UnsupportedSignature" }>
  /** Its `expires` is past or does not parse. */
  | Readonly<{ kind: "Expired" }>
  /**
   * The document uses JSON-LD Mastodon refuses (`@graph`, `@included`,
   * `@reverse`, more than 1000 values), names a context the Worker does not
   * ship, or is not valid JSON-LD.
   */
  | Readonly<{ kind: "UnsupportedJsonLd" }>
  /**
   * The document, or the signature, does not read the same as JSON and as
   * the JSON-LD the signature covers (see {@link readsAsSigned}).
   */
  | Readonly<{ kind: "AmbiguousJsonLd" }>;

const SignatureSchema = z.looseObject({
  type: z.string(),
  creator: z.string().min(1),
  signatureValue: z.string().min(1),
  expires: z.string().optional(),
});
const parseSignature = schemaResult(SignatureSchema);
const SignedDocumentSchema = z.looseObject({ signature: z.record(z.string(), z.unknown()) });
const parseSignedDocument = schemaResult(SignedDocumentSchema);

/** A Linked Data signature an activity carries, read but not yet checked. */
export type LdSignedDocument = Readonly<{
  /** The key that signed (`creator`). */
  keyId: string;
  signatureValue: string;
  /** The signature's options, which it covers: all but `type`, `id` and the value. */
  options: Readonly<Record<string, unknown>>;
  /** The `signature` object as received. */
  signature: Readonly<Record<string, unknown>>;
  /** The document without its `signature`. */
  document: Readonly<Record<string, unknown>>;
}>;

/** Whether `value` stays within Mastodon's `check_jsonld_limits!`. */
const withinJsonLdLimits = (value: unknown): boolean => {
  let budget = JSONLD_NODE_BUDGET;
  const visit = (node: unknown): boolean => {
    budget -= 1;
    if (budget < 0) {
      return false;
    }
    if (Array.isArray(node)) {
      return node.every(visit);
    }
    if (typeof node === "object" && node !== null) {
      return Object.entries(node).every(
        ([key, child]) => !UNSUPPORTED_KEYWORDS.has(key) && visit(child),
      );
    }
    return true;
  };
  return visit(value);
};

/**
 * `body` when it carries a Linked Data `signature` that may be forwarded:
 * Mastodon forwards an activity when, after its JSON-LD checks, the body
 * still has one (`@json['signature'].present?`). The receivers verify it.
 */
export const forwardableBody = (body: unknown): Readonly<Record<string, unknown>> | undefined => {
  const signed = parseSignedDocument(body);
  return signed.isOk() && withinJsonLdLimits(signed.value) ? signed.value : undefined;
};

/**
 * The `RsaSignature2017` signature of `body`, as Mastodon's `verify_actor!`
 * reads it before it looks up the key: only one that has not expired by
 * `now`, on a document within Mastodon's JSON-LD limits.
 */
export const readLdSignature = (
  body: unknown,
  now: Date,
): Result<LdSignedDocument, LdSignatureRefusal> => {
  const signed = parseSignedDocument(body);
  if (signed.isErr()) {
    return err({ kind: "Unsigned" });
  }
  const signature = parseSignature(signed.value.signature);
  if (signature.isErr() || signature.value.type !== LD_SIGNATURE_TYPE) {
    return err({ kind: "UnsupportedSignature" });
  }
  if (signature.value.expires !== undefined) {
    const expires = Date.parse(signature.value.expires);
    if (Number.isNaN(expires) || expires < now.getTime()) {
      return err({ kind: "Expired" });
    }
  }
  if (!withinJsonLdLimits(signed.value)) {
    return err({ kind: "UnsupportedJsonLd" });
  }
  const { signature: _signature, ...document } = signed.value;
  const { type: _type, id: _id, signatureValue: _value, ...options } = signature.value;
  return ok({
    keyId: signature.value.creator,
    signatureValue: signature.value.signatureValue,
    options,
    signature: signed.value.signature,
    document,
  });
};

/**
 * Each context a document may name, under `https://` and `http://` as
 * Mastodon preloads them. Any other is refused: a context is never fetched.
 */
const loadContext = async (url: string) => {
  const document = JSONLD_CONTEXTS.get(url.replace(/^http:\/\//, "https://"));
  if (document === undefined) {
    throw new Error(`JSON-LD context not shipped: ${url}`);
  }
  return { contextUrl: null, documentUrl: url, document };
};

/**
 * Mastodon's `JsonLdHelper#canonicalize`: URDNA2015 N-Quads of `document`.
 * Terms that do not expand are dropped, as Ruby's JSON-LD processor drops
 * them (`safe: false`), and `maxWorkFactor` bounds the work a crafted graph
 * can ask of the canonicalizer.
 */
export const canonicalizeJsonLd = async (
  document: unknown,
): Promise<Result<string, Readonly<{ kind: "UnsupportedJsonLd" }>>> => {
  try {
    return ok(
      await jsonld.canonize(document, {
        format: "application/n-quads",
        documentLoader: loadContext,
        safe: false,
        canonizeOptions: { algorithm: "RDFC-1.0", maxWorkFactor: 1 },
      }),
    );
  } catch {
    return err({ kind: "UnsupportedJsonLd" });
  }
};

const encoder = new TextEncoder();

const sha256Hex = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** What the RSA key signs: the hex SHA-256 of the canonical options, then of the document. */
const signedBytes = async (
  options: Readonly<Record<string, unknown>>,
  document: Readonly<Record<string, unknown>>,
): Promise<Result<Uint8Array, Readonly<{ kind: "UnsupportedJsonLd" }>>> => {
  const [canonicalOptions, canonicalDocument] = await Promise.all([
    canonicalizeJsonLd({ ...options, "@context": IDENTITY_CONTEXT }),
    canonicalizeJsonLd(document),
  ]);
  if (canonicalOptions.isErr()) {
    return err(canonicalOptions.error);
  }
  if (canonicalDocument.isErr()) {
    return err(canonicalDocument.error);
  }
  const [optionsHash, documentHash] = await Promise.all([
    sha256Hex(canonicalOptions.value),
    sha256Hex(canonicalDocument.value),
  ]);
  return ok(encoder.encode(optionsHash + documentHash));
};

const PUBLIC_COLLECTION = "https://www.w3.org/ns/activitystreams#Public";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether the JSON value `received` reads as `compacted`, its compaction:
 * the same members with the same values, but where Mastodon's
 * `patch_for_forwarding!` lets them differ (a list of one compacts to its
 * item, the public collection to `as:Public`) and a `null`, which
 * compaction drops. A nested `@context` never matches.
 */
const readsAs = (received: unknown, compacted: unknown): boolean => {
  if (Array.isArray(received)) {
    const items: ReadonlyArray<unknown> = Array.isArray(compacted)
      ? compacted
      : compacted === undefined
        ? []
        : [compacted];
    return received.length === items.length && received.every((v, i) => readsAs(v, items[i]));
  }
  if (isRecord(received)) {
    return isRecord(compacted) && !("@context" in received) && sameMembers(received, compacted);
  }
  return received === compacted || (received === PUBLIC_COLLECTION && compacted === "as:Public");
};

const sameMembers = (
  received: Readonly<Record<string, unknown>>,
  compacted: Readonly<Record<string, unknown>>,
): boolean =>
  [...new Set([...Object.keys(received), ...Object.keys(compacted)])].every((key) =>
    received[key] === null ? compacted[key] === undefined : readsAs(received[key], compacted[key]),
  );

const ABSOLUTE_IRI = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Whether every member of the expanded document becomes RDF, so that the
 * signature covers it: no property that expands to a blank node (a term no
 * context defines, kept by the activity streams `@vocab` of `_:` but
 * dropped from the graph), and no relative IRI as a node or a type.
 */
const allCovered = (expanded: unknown): boolean => {
  if (Array.isArray(expanded)) {
    return expanded.every(allCovered);
  }
  if (!isRecord(expanded)) {
    return true;
  }
  return Object.entries(expanded).every(([key, value]) => {
    if (key.startsWith("_:")) {
      return false;
    }
    if (key === "@id") {
      return typeof value === "string" && ABSOLUTE_IRI.test(value);
    }
    if (key === "@type" && !("@value" in expanded)) {
      return (Array.isArray(value) ? value : [value]).every(
        (type) => typeof type === "string" && ABSOLUTE_IRI.test(type),
      );
    }
    return key === "@value" || allCovered(value);
  });
};

/**
 * Whether `document` (but its own `@context`) reads the same as plain JSON
 * and compacted to `context`. A signature covers the JSON-LD graph, and
 * tstodon reads the JSON: a term that a nested `@context` redefines, a
 * compact or full IRI where a term is expected, `@id` for `id` or a term no
 * context defines keep the graph, and so the signature, while changing what
 * the JSON says. Mastodon reads the compacted form instead; tstodon takes
 * only a document whose JSON already is that form.
 */
const readsAsCompacted = async (
  document: Readonly<Record<string, unknown>>,
  context: unknown,
): Promise<Result<boolean, Readonly<{ kind: "UnsupportedJsonLd" }>>> => {
  try {
    const options = { documentLoader: loadContext, safe: false };
    const [expanded, compacted] = await Promise.all([
      jsonld.expand(document, options),
      jsonld.compact(document, context, options),
    ]);
    if (!allCovered(expanded) || !isRecord(compacted)) {
      return ok(false);
    }
    const { "@context": _given, ...received } = document;
    const { "@context": _target, ...members } = compacted;
    return ok(sameMembers(received, members));
  } catch {
    return err({ kind: "UnsupportedJsonLd" });
  }
};

/**
 * Whether `signed` reads as what its signature covers: the document
 * compacted to the context Mastodon reads activities in, and the signature
 * compacted to the identity context, as Mastodon's `verify_actor!` reads it.
 */
const readsAsSigned = async (
  signed: LdSignedDocument,
): Promise<Result<void, LdSignatureRefusal>> => {
  // `type` is a bare name the identity context does not define; it is
  // compared as a string, and not covered.
  const { type: _type, ...options } = signed.signature;
  const [document, signature] = await Promise.all([
    readsAsCompacted(signed.document, MASTODON_FULL_CONTEXT),
    readsAsCompacted({ ...options, "@context": IDENTITY_CONTEXT }, IDENTITY_CONTEXT),
  ]);
  if (document.isErr()) {
    return err(document.error);
  }
  if (signature.isErr()) {
    return err(signature.error);
  }
  return document.value && signature.value ? ok(undefined) : err({ kind: "AmbiguousJsonLd" });
};

/**
 * The bytes `signed`'s signature covers, once the body is found to read as
 * them ({@link readsAsSigned}). Canonicalizing is the costly part of a
 * check, so a caller that tries more than one key computes this once.
 */
export const ldSignedBytes = async (
  signed: LdSignedDocument,
): Promise<Result<Uint8Array, LdSignatureRefusal>> => {
  const unambiguous = await readsAsSigned(signed);
  if (unambiguous.isErr()) {
    return err(unambiguous.error);
  }
  return signedBytes(signed.options, signed.document);
};

/** Base64 as Ruby's lenient `Base64.decode64` reads it: whitespace is ignored. */
const decodeBase64 = (value: string): Uint8Array | undefined => {
  try {
    return Uint8Array.from(atob(value.replace(/\s/g, "")), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

/** Whether `publicKeyPem` (an RSA key) made `signed`'s signature over `bytes`. */
export const verifyLdSignature = async (
  signed: LdSignedDocument,
  bytes: Uint8Array,
  publicKeyPem: string,
): Promise<boolean> => {
  const signature = decodeBase64(signed.signatureValue);
  const key = await importRsaPublicKey(publicKeyPem);
  if (signature === undefined || key === undefined) {
    return false;
  }
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, bytes);
};

/** An ISO 8601 instant without fractional seconds, as Ruby's `Time#iso8601`. */
const iso8601 = (instant: Date): string => `${instant.toISOString().slice(0, 19)}Z`;

export type LdSigningError = Readonly<{ kind: "UnsupportedJsonLd" } | { kind: "InvalidKey" }>;

/** The `signature` object `sign!` adds to a document. */
export type LdSignature = Readonly<{
  type: typeof LD_SIGNATURE_TYPE;
  creator: string;
  created: string;
  expires: string;
  signatureValue: string;
}>;

/**
 * The signature of `document` (without any `signature` it has) by `keyId`'s
 * private key at `now`, valid for two days, as Mastodon's
 * `LinkedDataSignature#sign!` makes it.
 */
export const ldSignature = async (
  document: Readonly<Record<string, unknown>>,
  key: Readonly<{ keyId: string; privateKeyJwk: SensitiveValue<string> }>,
  now: Date,
): Promise<Result<LdSignature, LdSigningError>> => {
  const options = {
    type: LD_SIGNATURE_TYPE,
    creator: key.keyId,
    created: iso8601(now),
    expires: iso8601(new Date(now.getTime() + SIGNATURE_LIFETIME_MS)),
  };
  const { type: _type, ...covered } = options;
  const { signature: _previous, ...unsigned } = document;
  const bytes = await signedBytes(covered, unsigned);
  if (bytes.isErr()) {
    return err(bytes.error);
  }
  const privateKey = await importRsaPrivateKey(key.privateKeyJwk);
  if (privateKey.isErr()) {
    return err({ kind: "InvalidKey" });
  }
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey.value, bytes.value),
  );
  return ok({ ...options, signatureValue: btoa(String.fromCharCode(...signature)) });
};

/**
 * `document` with its {@link ldSignature}, as Mastodon's `sign!` returns it:
 * the security context is added to `@context` after signing, as there.
 */
export const signLdDocument = async (
  document: Readonly<Record<string, unknown>>,
  key: Readonly<{ keyId: string; privateKeyJwk: SensitiveValue<string> }>,
  now: Date,
): Promise<Result<Record<string, unknown>, LdSigningError>> => {
  const signature = await ldSignature(document, key, now);
  if (signature.isErr()) {
    return err(signature.error);
  }
  const given: unknown = document["@context"];
  const entries: ReadonlyArray<unknown> = Array.isArray(given)
    ? given
    : given === undefined
      ? []
      : [given];
  const context: unknown[] = [...new Set([...entries, SECURITY_CONTEXT])];
  return ok({
    ...document,
    "@context": context.length === 1 ? context[0] : context,
    signature: signature.value,
  });
};
