import { type SensitiveValue, warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import {
  checkContentDigest,
  checkMessageSignatureStrength,
  contentDigestHeader,
  coversComponent,
  type MessageSignature,
  type MessageSignatureParseError,
  parseMessageSignature,
  signMessageRequest,
  verifyMessageSignature,
} from "./http-message-signature";
import { parseJsonColumn } from "./json-column";
import { z } from "zod";

export const RsaPrivateJwkSchema = z.object({
  kty: z.literal("RSA"),
  n: z.string().min(1),
  e: z.string().min(1),
  d: z.string().min(1),
  p: z.string().min(1),
  q: z.string().min(1),
  dp: z.string().min(1),
  dq: z.string().min(1),
  qi: z.string().min(1),
  alg: z.string().optional(),
  ext: z.boolean().optional(),
  key_ops: z.array(z.string()).optional(),
});

const encoder = new TextEncoder();

export const sha256DigestHeader = async (body: string): Promise<string> => {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(body));
  const bytes = new Uint8Array(hash);
  return `SHA-256=${btoa(String.fromCharCode(...bytes))}`;
};

export const buildSigningString = (
  method: string,
  pathAndQuery: string,
  headers: ReadonlyArray<string>,
  headerValues: Record<string, string>,
): string =>
  headers
    .map((name) => {
      if (name === "(request-target)") {
        return `(request-target): ${method.toLowerCase()} ${pathAndQuery}`;
      }
      return `${name}: ${headerValues[name] ?? ""}`;
    })
    .join("\n");

export type SignatureError = Readonly<{
  kind: "InvalidSignature";
  message: string;
}>;

/** An RSA private key (a stored JWK) for RSASSA-PKCS1-v1_5 with SHA-256. */
export const importRsaPrivateKey = async (
  privateKeyJwk: SensitiveValue<string>,
): Promise<Result<CryptoKey, string>> => {
  const parsed = parseJsonColumn(RsaPrivateJwkSchema, privateKeyJwk.reveal());
  if (parsed.isErr()) {
    return err(parsed.error.message);
  }
  const jwk: JsonWebKey = {
    kty: parsed.value.kty,
    n: parsed.value.n,
    e: parsed.value.e,
    d: parsed.value.d,
    p: parsed.value.p,
    q: parsed.value.q,
    dp: parsed.value.dp,
    dq: parsed.value.dq,
    qi: parsed.value.qi,
  };
  if (parsed.value.alg !== undefined) {
    jwk.alg = parsed.value.alg;
  }
  if (parsed.value.ext !== undefined) {
    jwk.ext = parsed.value.ext;
  }
  if (parsed.value.key_ops !== undefined) {
    jwk.key_ops = [...parsed.value.key_ops];
  }
  return ok(
    await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  );
};

/** Sign `headers` (with their `values`) for `method url`; returns the draft-cavage Signature header. */
const signCavageRequest = async (
  method: string,
  url: URL,
  privateKeyJwk: SensitiveValue<string>,
  keyId: string,
  headers: ReadonlyArray<string>,
  values: Record<string, string>,
): Promise<Result<string, SignatureError>> => {
  const signingString = buildSigningString(method, url.pathname + url.search, headers, values);
  const imported = await importRsaPrivateKey(privateKeyJwk);
  if (imported.isErr()) {
    return err({ kind: "InvalidSignature", message: imported.error });
  }
  const key = imported.value;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingString),
  );
  const binary = String.fromCharCode(...new Uint8Array(signature));
  return ok(
    `keyId="${keyId}",algorithm="rsa-sha256",headers="${headers.join(" ")}",signature="${btoa(binary)}"`,
  );
};

/**
 * How a request is signed: draft-cavage, or an RFC 9421 message signature,
 * which Mastodon's `Request` sends only once a draft-cavage request is
 * answered 400 or 401 (see {@link fetchDoubleKnocking}).
 */
export type SignatureScheme = RequestSignature["kind"];

/**
 * Headers for a signed delivery POST: draft-cavage over
 * `(request-target) host date digest`, or RFC 9421 over `@method`,
 * `@target-uri` and `content-digest`, as Mastodon's `Request` signs each.
 */
export const signInboxRequest = async (
  url: URL,
  privateKeyJwk: SensitiveValue<string>,
  keyId: string,
  body: string,
  at: Date = new Date(),
  scheme: SignatureScheme = "Cavage",
): Promise<Result<Headers, SignatureError>> => {
  const date = at.toUTCString();
  const common = { Host: url.host, Date: date, "Content-Type": "application/activity+json" };
  if (scheme === "MessageSignature") {
    const digest = await contentDigestHeader(body);
    const signed = await signMessage(url, "POST", privateKeyJwk, keyId, at, {
      "Content-Digest": digest,
    });
    return signed.map((value) => new Headers({ ...common, "Content-Digest": digest, ...value }));
  }
  const digest = await sha256DigestHeader(body);
  const signature = await signCavageRequest(
    "post",
    url,
    privateKeyJwk,
    keyId,
    ["(request-target)", "host", "date", "digest"],
    { host: url.host, date, digest },
  );
  return signature.map((value) => new Headers({ ...common, Digest: digest, Signature: value }));
};

/**
 * Headers for a signed fetch GET (authorized fetch), as Mastodon's `Request`
 * signs one: draft-cavage over `(request-target) host date accept`, or RFC
 * 9421 over `@method` and `@target-uri`. The caller sends `Accept` exactly
 * as given here, and the request goes to `url.host`.
 */
export const signFetchRequest = async (
  url: URL,
  privateKeyJwk: SensitiveValue<string>,
  keyId: string,
  accept: string,
  date: Date = new Date(),
  scheme: SignatureScheme = "Cavage",
): Promise<
  Result<Readonly<{ Date: string; Signature: string; "Signature-Input"?: string }>, SignatureError>
> => {
  const dateHeader = date.toUTCString();
  if (scheme === "MessageSignature") {
    const signed = await signMessage(url, "GET", privateKeyJwk, keyId, date, {});
    return signed.map((value) => ({ Date: dateHeader, ...value }));
  }
  const signature = await signCavageRequest(
    "get",
    url,
    privateKeyJwk,
    keyId,
    ["(request-target)", "host", "date", "accept"],
    { host: url.host, date: dateHeader, accept },
  );
  return signature.map((value) => ({ Date: dateHeader, Signature: value }));
};

const signMessage = async (
  url: URL,
  method: "GET" | "POST",
  privateKeyJwk: SensitiveValue<string>,
  keyId: string,
  at: Date,
  headers: Record<string, string>,
): Promise<Result<Readonly<{ "Signature-Input": string; Signature: string }>, SignatureError>> => {
  const imported = await importRsaPrivateKey(privateKeyJwk);
  if (imported.isErr()) {
    return err({ kind: "InvalidSignature", message: imported.error });
  }
  const signed = await signMessageRequest(
    new Request(url, { method, headers }),
    imported.value,
    keyId,
    at,
  );
  return signed.mapErr(() => ({ kind: "InvalidSignature", message: "unsignable request" }));
};

/**
 * Send a signed request as Mastodon's `Request#perform` does: signed with
 * draft-cavage first, and again with an RFC 9421 message signature when
 * that is answered 400 or 401 ("double-knocking"). `send` signs and sends
 * the request with the scheme it is given.
 */
export const fetchDoubleKnocking = async (
  send: (scheme: SignatureScheme) => Promise<Response>,
): Promise<Response> => {
  const response = await send("Cavage");
  if (response.status !== 400 && response.status !== 401) {
    return response;
  }
  await response.body?.cancel();
  return send("MessageSignature");
};

/** A draft-cavage `Signature` header. */
export type CavageSignature = Readonly<{
  kind: "Cavage";
  keyId: string;
  algorithm: string;
  headers: ReadonlyArray<string>;
  signature: string;
}>;

export const parseSignatureHeader = (header: string): CavageSignature | undefined => {
  const fields = new Map<string, string>();
  for (const part of header.split(",")) {
    const match = part.trim().match(/^([a-zA-Z]+)=(?:"([^"]*)"|([^"]*))$/);
    if (!match) {
      continue;
    }
    const name = match[1];
    const value = match[2] ?? match[3];
    if (name && value !== undefined) {
      fields.set(name, value);
    }
  }
  const keyId = fields.get("keyId");
  const algorithm = fields.get("algorithm") ?? "rsa-sha256";
  const headers = fields.get("headers");
  const signature = fields.get("signature");
  if (!keyId || !headers || !signature) {
    return undefined;
  }
  return {
    kind: "Cavage",
    keyId,
    algorithm,
    headers: headers.split(" ").filter((name) => name.length > 0),
    signature,
  };
};

/** A request's signature, of either scheme. */
export type RequestSignature = CavageSignature | MessageSignature;

export type RequestSignatureError =
  /** No `Signature` header. */
  | Readonly<{ kind: "Unsigned" }>
  /** A `Signature` header that is not a draft-cavage signature. */
  | Readonly<{ kind: "MalformedCavageSignature" }>
  | MessageSignatureParseError;

/**
 * The signature a request carries, as Mastodon's `SignedRequest` reads it:
 * only a request with a `Signature` header is signed, and one that also
 * carries `Signature-Input` is an RFC 9421 message signature.
 */
export const parseRequestSignature = (
  headers: Headers,
): Result<RequestSignature, RequestSignatureError> => {
  const signature = headers.get("Signature");
  if (signature === null || signature === "") {
    return err({ kind: "Unsigned" });
  }
  const input = headers.get("Signature-Input");
  if (input !== null && input !== "") {
    return parseMessageSignature(input, signature);
  }
  const cavage = parseSignatureHeader(signature);
  return cavage === undefined ? err({ kind: "MalformedCavageSignature" }) : ok(cavage);
};

/**
 * How long a signature stays valid after its `Date`: Mastodon's
 * `SignedRequest#matches_time_window?` gives a signature with no `expires`
 * 5 minutes from its creation.
 */
export const SIGNATURE_VALIDITY_MS = 5 * 60 * 1000;

/**
 * The clock skew allowed on either side of the window: Mastodon's
 * `SignedRequest::CLOCK_SKEW_MARGIN` (1 hour). A `Date` may be this far
 * ahead, and at most {@link SIGNATURE_VALIDITY_MS} plus this old (65 minutes).
 */
export const SIGNATURE_CLOCK_SKEW_MS = 60 * 60 * 1000;

/** Why a signature is refused before any key is looked up (SIG-1). */
export type SignatureStrengthError =
  /** `date` is not among the signed headers (draft-cavage). */
  | Readonly<{ kind: "DateNotSigned" }>
  /** A request with a body whose signature does not cover `digest` (RFC 9421: `content-digest`). */
  | Readonly<{ kind: "DigestNotSigned" }>
  /** An RFC 9421 signature that does not cover `@method` and `@target-uri`. */
  | Readonly<{ kind: "TargetNotSigned" }>
  /** The signed `Date` (RFC 9421: `created`, `expires`) is unparseable, too old or too far ahead. */
  | Readonly<{ kind: "SignatureExpired"; detail: "invalid" | "past" | "future" }>;

const hasBody = (method: string): boolean => !["GET", "HEAD"].includes(method.toUpperCase());

/**
 * Whether a parsed signature is one this server accepts at all, before any
 * key is fetched, as Mastodon's `verify_signature_strength!` and
 * `matches_time_window?`: it must sign `date`, a request with a body must
 * sign `digest`, and the `Date` must be at most 65 minutes old
 * ({@link SIGNATURE_VALIDITY_MS} plus {@link SIGNATURE_CLOCK_SKEW_MS}) and at
 * most {@link SIGNATURE_CLOCK_SKEW_MS} ahead. A captured signed request
 * therefore cannot be replayed after the window. An RFC 9421 signature is
 * checked by `checkMessageSignatureStrength` instead. `(created)` is not accepted
 * in place of `date`: the signing string here has no `(created)`. An
 * `expires` parameter does not stretch the window, as nothing signs it.
 */
export const checkSignatureStrength = (
  request: Request,
  parsed: RequestSignature,
  now: number = Date.now(),
): SignatureStrengthError | undefined => {
  if (parsed.kind === "MessageSignature") {
    return checkMessageSignatureStrength(request, parsed, now);
  }
  const signed = new Set(parsed.headers.map((name) => name.toLowerCase()));
  if (!signed.has("date")) {
    return { kind: "DateNotSigned" };
  }
  if (hasBody(request.method) && !signed.has("digest")) {
    return { kind: "DigestNotSigned" };
  }
  const date = Date.parse(request.headers.get("Date") ?? "");
  if (Number.isNaN(date)) {
    return { kind: "SignatureExpired", detail: "invalid" };
  }
  if (now - date > SIGNATURE_VALIDITY_MS + SIGNATURE_CLOCK_SKEW_MS) {
    return { kind: "SignatureExpired", detail: "past" };
  }
  if (date - now > SIGNATURE_CLOCK_SKEW_MS) {
    return { kind: "SignatureExpired", detail: "future" };
  }
  return undefined;
};

const pemToSpki = (pem: string): ArrayBuffer => {
  const b64 = pem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  return Uint8Array.from(atob(b64), (char) => char.charCodeAt(0)).buffer;
};

const RSA_SHA256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** An RSA public key from its PEM (SPKI), or undefined when it is not one. */
export const importRsaPublicKey = async (publicKeyPem: string): Promise<CryptoKey | undefined> => {
  try {
    return await crypto.subtle.importKey("spki", pemToSpki(publicKeyPem), RSA_SHA256, false, [
      "verify",
    ]);
  } catch {
    return undefined;
  }
};

const bytesFromB64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

/**
 * A public key a signature names: a local account's, or a remote actor's
 * (`RemoteActorKey`). Mastodon checks a draft-cavage signature
 * (`rsa-sha256`, `hs2019`) with an RSA key only: with an Ed25519 key its
 * `SignedRequest` fails, and so does this. An RFC 9421 signature verifies
 * with either (`Keypair#linzer_public_key`).
 */
export type VerificationKey = Readonly<{ kind: "Rsa" | "Ed25519"; publicKeyPem: string }>;

const importVerificationKey = async (key: VerificationKey): Promise<CryptoKey | undefined> => {
  if (key.kind === "Rsa") {
    return importRsaPublicKey(key.publicKeyPem);
  }
  try {
    return await crypto.subtle.importKey(
      "spki",
      pemToSpki(key.publicKeyPem),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    return undefined;
  }
};

const verifyCavageSignature = async (
  request: Request,
  parsed: CavageSignature,
  key: VerificationKey,
  digest: string,
): Promise<boolean> => {
  if (key.kind !== "Rsa") {
    return false;
  }
  const url = new URL(request.url);
  // Every header the signer listed counts (Mastodon also signs `content-type`
  // on deliveries and `accept` on fetches), read from the request as sent.
  const headerValues: Record<string, string> = Object.fromEntries(
    parsed.headers
      .filter((name) => !name.startsWith("("))
      .map((name) => [name, request.headers.get(name) ?? ""]),
  );
  headerValues.host = request.headers.get("Host") ?? url.host;
  headerValues.digest = digest;
  const signingString = buildSigningString(
    request.method,
    url.pathname + url.search,
    parsed.headers,
    headerValues,
  );
  const publicKey = await importRsaPublicKey(key.publicKeyPem);
  if (publicKey === undefined) {
    return false;
  }
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    bytesFromB64(parsed.signature),
    encoder.encode(signingString),
  );
};

const verifySignature = async (
  request: Request,
  parsed: RequestSignature,
  key: VerificationKey,
): Promise<boolean> => {
  if (parsed.kind === "Cavage") {
    return verifyCavageSignature(request, parsed, key, request.headers.get("Digest") ?? "");
  }
  const publicKey = await importVerificationKey(key);
  return publicKey !== undefined && verifyMessageSignature(request, parsed, publicKey);
};

export type BodyDigestVerdict = "Match" | "Mismatch" | "Malformed";

/**
 * Whether the body is the one the signature covers: draft-cavage's `Digest`,
 * or RFC 9421's `Content-Digest` (RFC 9530, `sha-256` only), as Mastodon's
 * `verify_body_digest!`. A `Content-Digest` that is not a structured-field
 * dictionary is `Malformed`, which Mastodon answers 400.
 */
export const checkBodyDigest = async (
  request: Request,
  parsed: RequestSignature,
  body: string,
): Promise<BodyDigestVerdict> => {
  if (parsed.kind === "Cavage") {
    return request.headers.get("Digest") === (await sha256DigestHeader(body))
      ? "Match"
      : "Mismatch";
  }
  const verdict = await checkContentDigest(request.headers.get("Content-Digest"), body);
  switch (verdict.kind) {
    case "Match":
      return "Match";
    case "Malformed":
      return "Malformed";
    case "Missing":
    case "Mismatch":
      return "Mismatch";
  }
};

export const verifyInboxRequest = async (
  request: Request,
  key: VerificationKey,
  body: string,
): Promise<boolean> => {
  const parsed = parseRequestSignature(request.headers);
  return (
    parsed.isOk() &&
    checkSignatureStrength(request, parsed.value) === undefined &&
    (await checkBodyDigest(request, parsed.value, body)) === "Match" &&
    verifySignature(request, parsed.value, key)
  );
};

/**
 * A signed fetch (a GET with no body): a draft-cavage signature must cover
 * `(request-target)`, so it cannot be replayed against another resource (an
 * RFC 9421 one covers `@target-uri`), and pass {@link checkSignatureStrength},
 * so it cannot be replayed later. An RFC 9421 signature that covers
 * `content-digest` must digest the empty body, as Mastodon checks it.
 */
export const verifySignedFetch = async (
  request: Request,
  parsed: RequestSignature,
  key: VerificationKey,
): Promise<boolean> => {
  if (checkSignatureStrength(request, parsed) !== undefined) {
    return false;
  }
  const covered =
    parsed.kind === "Cavage"
      ? parsed.headers.includes("(request-target)")
      : !coversComponent(parsed, "content-digest") ||
        (await checkBodyDigest(request, parsed, "")) === "Match";
  return covered && verifySignature(request, parsed, key);
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([RsaPrivateJwkSchema]);
