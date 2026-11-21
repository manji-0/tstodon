/**
 * HTTP Message Signatures (RFC 9421) on requests, as Mastodon v4.7.5 makes
 * and checks them (`SignedRequest::HttpMessageSignature`, with the `linzer`
 * gem). A request is one when it carries `Signature-Input`; draft-cavage
 * signatures stay in `http-signature.ts`, which picks between the two.
 */
import { err, ok, type Result } from "neverthrow";
import { browserFacingOrigin } from "./browser-session";
import {
  parseSfDictionary,
  type SfBareItem,
  type SfInnerList,
  type SfItem,
  type SfParameters,
  serializeSfBareItem,
  serializeSfDictionary,
  serializeSfInnerList,
  serializeSfItem,
  serializeSfMember,
  sfLookup,
} from "./structured-field";

export type MessageSignature = Readonly<{
  kind: "MessageSignature";
  /** The `keyid` parameter. */
  keyId: string;
  /** The dictionary key both headers file the signature under (Mastodon's `sig1`). */
  label: string;
  /** The covered components and the signature's parameters, as sent. */
  input: SfInnerList;
  /** The `created` parameter, in seconds. */
  created: number;
  /** The `expires` parameter, in seconds, when there is one. */
  expires: number | undefined;
  signature: Uint8Array;
}>;

export type MessageSignatureParseError = Readonly<{
  kind:
    | "MalformedSignatureInput"
    /**
     * `linzer` takes one signature, or the one a verifier names. Mastodon
     * names none, so `Linzer::Signature.build` raises a `Linzer::Error` it
     * does not rescue (a 500); this server refuses it as unsigned (a 401),
     * as it refuses a `Signature-Input` that does not parse.
     */
    | "MultipleSignatures"
    /** No string `keyid` or integer `created` (Mastodon's `REQUIRED_PARAMETERS`). */
    | "MissingParameters"
    /** `Signature` is not a dictionary with the label's byte sequence. */
    | "MalformedSignature";
}>;

/**
 * The longest `Signature-Input`, `Signature` or `Content-Digest` read, in
 * characters: 8 KiB, the header line nginx (`large_client_header_buffers`,
 * 8k by default) lets through to Mastodon. Mastodon's own are about 200, and
 * a 4096-bit RSA signature is 690 in base64. A longer one is refused unread.
 */
export const MAX_SIGNATURE_FIELD_LENGTH = 8192;

/** The signature a request's `Signature-Input` and `Signature` carry. */
export const parseMessageSignature = (
  signatureInput: string,
  signature: string,
): Result<MessageSignature, MessageSignatureParseError> => {
  if (signatureInput.length > MAX_SIGNATURE_FIELD_LENGTH) {
    return err({ kind: "MalformedSignatureInput" });
  }
  if (signature.length > MAX_SIGNATURE_FIELD_LENGTH) {
    return err({ kind: "MalformedSignature" });
  }
  const inputs = parseSfDictionary(signatureInput);
  if (inputs.isOk() && inputs.value.length > 1) {
    return err({ kind: "MultipleSignatures" });
  }
  const entry = inputs.isOk() ? inputs.value[0] : undefined;
  if (entry === undefined) {
    return err({ kind: "MalformedSignatureInput" });
  }
  const [label, input] = entry;
  if (input.kind !== "InnerList" || input.items.some((item) => item.value.kind !== "String")) {
    return err({ kind: "MalformedSignatureInput" });
  }
  const keyId = sfLookup(input.params, "keyid");
  const created = sfLookup(input.params, "created");
  const expires = sfLookup(input.params, "expires");
  if (
    keyId?.kind !== "String" ||
    keyId.value === "" ||
    created?.kind !== "Integer" ||
    (expires !== undefined && expires.kind !== "Integer")
  ) {
    return err({ kind: "MissingParameters" });
  }
  const signatures = parseSfDictionary(signature);
  const value = signatures.isOk() ? sfLookup(signatures.value, label) : undefined;
  if (value?.kind !== "Item" || value.value.kind !== "ByteSequence") {
    return err({ kind: "MalformedSignature" });
  }
  return ok({
    kind: "MessageSignature",
    keyId: keyId.value,
    label,
    input,
    created: created.value,
    expires: expires?.value,
    signature: value.value.value,
  });
};

/** Whether the signature covers a component with no parameters, by name (`@method`, `content-digest`). */
export const coversComponent = (signature: MessageSignature, name: string): boolean =>
  signature.input.items.some(
    (item) => item.params.length === 0 && item.value.kind === "String" && item.value.value === name,
  );

/** How long a signature without `expires` is valid: Mastodon's `created_time + 5.minutes`. */
const DEFAULT_VALIDITY_S = 5 * 60;
/** `SignedRequest::EXPIRATION_WINDOW_LIMIT`: an `expires` counts up to 12 hours after `created`. */
const EXPIRATION_WINDOW_LIMIT_S = 12 * 60 * 60;
/** `SignedRequest::CLOCK_SKEW_MARGIN`. */
const CLOCK_SKEW_MARGIN_S = 60 * 60;

export type MessageSignatureStrengthError =
  /** `@method` or `@target-uri` is not covered. */
  | Readonly<{ kind: "TargetNotSigned" }>
  /** A POST whose signature does not cover `content-digest`. */
  | Readonly<{ kind: "DigestNotSigned" }>
  /** `created` is over an hour ahead, or the signature has expired. */
  | Readonly<{ kind: "SignatureExpired"; detail: "past" | "future" }>;

/**
 * Whether a signature is one Mastodon takes at all, before any key is
 * looked up: `SignedRequest#matches_time_window?` (valid 5 minutes after
 * `created`, or until `expires` but at most 12 hours, with an hour of clock
 * skew either side), `linzer`'s own `expires` check (no skew), and
 * `verify_signature_strength!` (`@method` and `@target-uri` covered, and
 * `content-digest` on a POST).
 */
export const checkMessageSignatureStrength = (
  request: Request,
  signature: MessageSignature,
  now: number = Date.now(),
): MessageSignatureStrengthError | undefined => {
  const nowS = now / 1000;
  const expiresS = Math.min(
    signature.expires ?? signature.created + DEFAULT_VALIDITY_S,
    signature.created + EXPIRATION_WINDOW_LIMIT_S,
  );
  if (signature.created > nowS + CLOCK_SKEW_MARGIN_S) {
    return { kind: "SignatureExpired", detail: "future" };
  }
  if (
    nowS > expiresS + CLOCK_SKEW_MARGIN_S ||
    (signature.expires !== undefined && Math.floor(nowS) >= signature.expires)
  ) {
    return { kind: "SignatureExpired", detail: "past" };
  }
  if (!coversComponent(signature, "@method") || !coversComponent(signature, "@target-uri")) {
    return { kind: "TargetNotSigned" };
  }
  if (request.method.toUpperCase() === "POST" && !coversComponent(signature, "content-digest")) {
    return { kind: "DigestNotSigned" };
  }
  return undefined;
};

/**
 * The URL the request was sent to. A TLS-terminating proxy in front of the
 * dev server leaves `request.url` `http:` and says `https` in
 * `X-Forwarded-Proto`, which Rack's `url` honours too.
 */
const targetUri = (request: Request): URL => {
  const url = new URL(request.url);
  return new URL(
    url.pathname + url.search,
    browserFacingOrigin(request.url, request.headers.get("X-Forwarded-Proto") ?? undefined),
  );
};

/** A string's characters as bytes, as Rack holds a header or a query; `undefined` past U+00FF. */
const latin1Bytes = (text: string): Uint8Array | undefined => {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0xff) {
      return undefined;
    }
    bytes[index] = code;
  }
  return bytes;
};

const BAD_ESCAPE = /%(?![0-9A-Fa-f]{2})/;

/**
 * Ruby's `URI.decode_www_form_component` (`plus`) or
 * `URI.decode_uri_component`, one character per byte: `undefined` for a `%`
 * without two hex digits, where Ruby raises.
 */
const percentDecode = (text: string, plus: boolean): string | undefined =>
  BAD_ESCAPE.test(text)
    ? undefined
    : (plus ? text.replaceAll("+", " ") : text).replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );

/** Ruby's `URI.encode_uri_component` over one character per byte: all but `*-.0-9A-Z_a-z` escaped. */
const percentEncode = (bytes: string): string =>
  bytes.replace(
    /[^*\-.0-9A-Z_a-z]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );

/** Rack's `QueryParser` limits: past them `params` raises, and `linzer` reads no parameter. */
const QUERY_PARAMS_LIMIT = 4096;
const QUERY_BYTESIZE_LIMIT = 4_194_304;

/**
 * The query's parameters as Rack's `Request#GET` reads them
 * (`parse_nested_query`): pairs split at `&` and the spaces after it, names
 * and values form-decoded, a name without `=` given an empty value, and the
 * last of a repeated name kept. `undefined` where Rack raises (a bad escape,
 * past its limits), and for a query with a name Rack nests (`a[b]`, `a[]`),
 * which this server does not read.
 */
const rackQueryParams = (query: string): ReadonlyMap<string, string> | undefined => {
  const params = new Map<string, string>();
  const pairs = query === "" ? [] : query.split(/& */);
  if (pairs.length > QUERY_PARAMS_LIMIT || query.length > QUERY_BYTESIZE_LIMIT) {
    return undefined;
  }
  for (const pair of pairs) {
    if (pair === "") {
      continue;
    }
    const equals = pair.indexOf("=");
    const name = percentDecode(equals < 0 ? pair : pair.slice(0, equals), true);
    const value = equals < 0 ? "" : percentDecode(pair.slice(equals + 1), true);
    if (name === undefined || value === undefined || name.indexOf("[", 1) >= 0) {
      return undefined;
    }
    if (name !== "") {
      params.set(name, value);
    }
  }
  return params;
};

/**
 * `@query-param` (RFC 9421 section 2.2.8) as `linzer` derives it: the `name`
 * parameter percent-decoded (`+` kept), looked up among the query's
 * parameters as Rack reads them, and the value percent-encoded as
 * `URI.encode_uri_component` does, a space as `%20`.
 */
const queryParam = (url: URL, name: SfBareItem | undefined): string | undefined => {
  const wanted = name?.kind === "String" ? percentDecode(name.value, false) : undefined;
  const value =
    wanted === undefined ? undefined : rackQueryParams(url.search.slice(1))?.get(wanted);
  return value === undefined ? undefined : percentEncode(value);
};

/** A derived component's value (RFC 9421 section 2.2), for the ones a request has. */
const derivedComponent = (
  request: Request,
  name: string,
  params: SfParameters,
): string | undefined => {
  const url = targetUri(request);
  switch (name) {
    case "@method":
      return request.method;
    case "@target-uri":
      return url.href;
    case "@authority":
      return url.host;
    case "@scheme":
      return url.protocol.slice(0, -1);
    case "@request-target":
      return url.pathname + url.search;
    case "@path":
      return url.pathname;
    case "@query":
      return url.search === "" ? "?" : url.search;
    case "@query-param":
      return queryParam(url, sfLookup(params, "name"));
    default:
      return undefined;
  }
};

/** An HTTP field name (a `token`), which `Headers.get` would otherwise throw on. */
const FIELD_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * A field's value. `Headers` strips its leading and trailing whitespace and
 * joins a field sent on several lines with ", ", as Puma does.
 */
const fieldValue = (request: Request, name: string): string | undefined =>
  FIELD_NAME.test(name) ? (request.headers.get(name) ?? undefined) : undefined;

/** The component parameters RFC 9421 registers (section 6.5.2); `linzer` refuses any other. */
const COMPONENT_PARAMETERS: ReadonlySet<string> = new Set(["sf", "key", "bs", "req", "tr", "name"]);

/** Whether a parameter is set as Ruby reads it: present, and not `?0`. */
const isSet = (params: SfParameters, key: string): boolean => {
  const value = sfLookup(params, key);
  return value !== undefined && !(value.kind === "Boolean" && !value.value);
};

/**
 * `;sf` and `;key` (RFC 9421 sections 2.1.1 and 2.1.2): the field read as a
 * dictionary, as `linzer` reads every such field, and reserialized whole, or
 * the member `key` names. Undefined when it does not parse, is empty, or has
 * no such member. A string member stays a string: behind Puma, whose header
 * values are binary strings, `starry` serializes it as a byte sequence.
 */
const structuredValue = (value: string, key: SfBareItem | undefined): string | undefined => {
  const dictionary = parseSfDictionary(value);
  if (dictionary.isErr()) {
    return undefined;
  }
  if (key === undefined) {
    return dictionary.value.length === 0 ? undefined : serializeSfDictionary(dictionary.value);
  }
  const member = key.kind === "String" ? sfLookup(dictionary.value, key.value) : undefined;
  return member === undefined ? undefined : serializeSfMember(member);
};

/**
 * A covered component's value as `linzer` 0.8.0's `Adapter::Abstract#retrieve`
 * derives it on a request. A parameter RFC 9421 does not register, `name` on
 * any component but `@query-param`, `;sf` or `;key` with `;bs`, `;tr` (no
 * trailers here) and `;req` (a response's) leave it undefined. `;bs` wraps
 * the value as one byte sequence: `Headers`, as Puma, joins a field's lines
 * before it is read, so a field sent on two lines is wrapped as one, where
 * RFC 9421 wraps each line.
 */
const componentValue = (request: Request, item: SfItem): string | undefined => {
  if (item.value.kind !== "String") {
    return undefined;
  }
  const name = item.value.value;
  const { params } = item;
  const structured = isSet(params, "sf") || sfLookup(params, "key") !== undefined;
  const binary = isSet(params, "bs");
  if (
    params.some(([key]) => !COMPONENT_PARAMETERS.has(key)) ||
    (isSet(params, "name") && name !== "@query-param") ||
    (structured && binary) ||
    isSet(params, "tr") ||
    isSet(params, "req")
  ) {
    return undefined;
  }
  const value = name.startsWith("@")
    ? derivedComponent(request, name, params)
    : fieldValue(request, name);
  if (value === undefined || !(structured || binary)) {
    return value;
  }
  if (structured) {
    return structuredValue(value, sfLookup(params, "key"));
  }
  const bytes = latin1Bytes(value);
  return bytes === undefined ? undefined : `:${base64(bytes)}:`;
};

/** A parameter value as Ruby's `==` compares it: an integer equals the same decimal. */
const comparable = (value: SfBareItem): string => {
  switch (value.kind) {
    case "Integer":
    case "Decimal":
      return `n${value.value}`;
    case "String":
      return `s${value.value}`;
    case "ByteSequence":
      return `s${String.fromCharCode(...value.value)}`;
    case "Token":
      return `t${value.value}`;
    case "Boolean":
      return `b${value.value}`;
  }
};

/**
 * A component as `linzer`'s `validate_uniqueness` tells one from another:
 * its name and its parameters, in any order.
 */
const componentIdentity = (item: SfItem): string =>
  JSON.stringify([
    serializeSfBareItem(item.value),
    item.params.map(([key, value]) => `${key}=${comparable(value)}`).sort(),
  ]);

/**
 * The signature base (RFC 9421 section 2.5): one line per covered
 * component, then `@signature-params`, the input as it was sent. Undefined
 * when a component is missing from the request, repeated (its parameters in
 * any order), or one `linzer` does not derive on a request
 * ({@link componentValue}, `@status`).
 */
export const messageSignatureBase = (request: Request, input: SfInnerList): string | undefined => {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const item of input.items) {
    const value = componentValue(request, item);
    const identity = componentIdentity(item);
    if (value === undefined || seen.has(identity)) {
      return undefined;
    }
    seen.add(identity);
    lines.push(`${serializeSfItem(item)}: ${value}`);
  }
  lines.push(`"@signature-params": ${serializeSfInnerList(input)}`);
  return lines.join("\n");
};

const encoder = new TextEncoder();

/** The WebCrypto verification each key type makes: `rsa-v1_5-sha256` or `ed25519`. */
const algorithmOf = (key: CryptoKey): Readonly<{ name: "Ed25519" | "RSASSA-PKCS1-v1_5" }> =>
  key.algorithm.name === "Ed25519" ? { name: "Ed25519" } : { name: "RSASSA-PKCS1-v1_5" };

/**
 * Whether `publicKey` made the signature over this request. The algorithm
 * is the key's: Mastodon reads no `alg` parameter, an RSA key verifies
 * `rsa-v1_5-sha256` and an Ed25519 key `ed25519`.
 */
export const verifyMessageSignature = async (
  request: Request,
  signature: MessageSignature,
  publicKey: CryptoKey,
): Promise<boolean> => {
  const base = messageSignatureBase(request, signature.input);
  if (base === undefined) {
    return false;
  }
  try {
    return await crypto.subtle.verify(
      algorithmOf(publicKey),
      publicKey,
      signature.signature,
      encoder.encode(base),
    );
  } catch {
    return false;
  }
};

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const sha256 = async (body: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body)));

/** `Content-Digest` (RFC 9530) for `body`, as Mastodon's `Request` sends it. */
export const contentDigestHeader = async (body: string): Promise<string> =>
  `sha-256=:${base64(await sha256(body))}:`;

export type ContentDigestVerdict =
  | Readonly<{ kind: "Match" }>
  | Readonly<{ kind: "Missing" }>
  /** Not a structured-field dictionary: Mastodon's `MalformedHeaderError`, a 400. */
  | Readonly<{ kind: "Malformed" }>
  /** No `sha-256` digest, or one that is not the body's. */
  | Readonly<{ kind: "Mismatch" }>;

/** `verify_body_digest!` for a message signature: only `sha-256` counts. */
export const checkContentDigest = async (
  header: string | null,
  body: string,
): Promise<ContentDigestVerdict> => {
  if (header === null) {
    return { kind: "Missing" };
  }
  if (header.length > MAX_SIGNATURE_FIELD_LENGTH) {
    return { kind: "Malformed" };
  }
  const digests = parseSfDictionary(header);
  if (digests.isErr()) {
    return { kind: "Malformed" };
  }
  const digest = sfLookup(digests.value, "sha-256");
  if (digest?.kind !== "Item" || digest.value.kind !== "ByteSequence") {
    return { kind: "Mismatch" };
  }
  return base64(digest.value.value) === base64(await sha256(body))
    ? { kind: "Match" }
    : { kind: "Mismatch" };
};

/**
 * `Signature-Input` and `Signature` for a request, as Mastodon's `Request`
 * double-knocks: label `sig1`, `@method` and `@target-uri`, and
 * `content-digest` when the request carries one (a POST), with `created`
 * and `keyid`. `request` must already carry its `Content-Digest`.
 */
export const signMessageRequest = async (
  request: Request,
  privateKey: CryptoKey,
  keyId: string,
  at: Date = new Date(),
): Promise<Result<Readonly<{ "Signature-Input": string; Signature: string }>, "Unsignable">> => {
  const input: SfInnerList = {
    kind: "InnerList",
    items: [
      "@method",
      "@target-uri",
      ...(request.headers.has("content-digest") ? ["content-digest"] : []),
    ].map((name) => ({ kind: "Item", value: { kind: "String", value: name }, params: [] })),
    params: [
      ["created", { kind: "Integer", value: Math.floor(at.getTime() / 1000) }],
      ["keyid", { kind: "String", value: keyId }],
    ],
  };
  const base = messageSignatureBase(request, input);
  if (base === undefined) {
    return err("Unsignable");
  }
  const signature = new Uint8Array(
    await crypto.subtle.sign(algorithmOf(privateKey), privateKey, encoder.encode(base)),
  );
  return ok({
    "Signature-Input": `sig1=${serializeSfInnerList(input)}`,
    Signature: `sig1=:${base64(signature)}:`,
  });
};
