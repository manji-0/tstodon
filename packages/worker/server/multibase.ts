/**
 * Multibase values as Mastodon's `Multibase` reads them: base58btc (`z`) and
 * base64url (`u`), the two bases FEP-521a keys and FEP-8b32 proofs use, and
 * the multicodec-tagged public keys (`publicKeyMultibase`) it turns into PEM.
 */

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Joins byte arrays without spreading them into arguments. */
const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

/**
 * What `Multibase.decode` makes of a value: its bytes; `Unread` where it
 * raises `Multibase::Error` (no value, a base it does not read); `Malformed`
 * where the base's own decoder raises `ArgumentError` (`base58` and Ruby's
 * `Base64`), which nothing in Mastodon rescues.
 */
type Decoded =
  | Readonly<{ kind: "Bytes"; bytes: Uint8Array }>
  | Readonly<{ kind: "Unread" }>
  | Readonly<{ kind: "Malformed" }>;

const UNREAD: Decoded = { kind: "Unread" };
const MALFORMED: Decoded = { kind: "Malformed" };

const base58Digits: ReadonlyMap<string, number> = new Map(
  BASE58_ALPHABET.split("").map((char, index) => [char, index]),
);

const isBase58 = (text: string): boolean => /^[1-9A-HJ-NP-Za-km-z]*$/.test(text);

/** Bitcoin-alphabet base58, as the `base58` gem decodes it: each leading `1` is a zero byte. */
const decodeBase58 = (text: string): Decoded => {
  if (!isBase58(text)) {
    return MALFORMED;
  }
  let value = 0n;
  for (const char of text) {
    value = value * 58n + BigInt(base58Digits.get(char) ?? 0);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  const zeros = /^1*/.exec(text)?.[0].length ?? 0;
  return { kind: "Bytes", bytes: concat(new Uint8Array(zeros), Uint8Array.from(bytes)) };
};

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Ruby's `Base64.urlsafe_decode64`: a value that does not end in `=` is
 * padded to a multiple of four, `-` and `_` read as `+` and `/` (which it
 * also takes), then `strict_decode64` refuses anything but whole groups,
 * padding only at the end, and bits left over after the last byte.
 */
const decodeBase64Url = (text: string): Decoded => {
  const padded =
    !text.endsWith("=") && text.length % 4 !== 0
      ? text.padEnd(text.length + 4 - (text.length % 4), "=")
      : text;
  const standard = padded.replaceAll("-", "+").replaceAll("_", "/");
  if (!STRICT_BASE64.test(standard)) {
    return MALFORMED;
  }
  const digit = (offset: number): number =>
    BASE64_ALPHABET.indexOf(standard.charAt(standard.length - offset));
  const leftover = standard.endsWith("==")
    ? digit(3) & 0x0f
    : standard.endsWith("=")
      ? digit(2) & 0x03
      : 0;
  if (leftover !== 0) {
    return MALFORMED;
  }
  const binary = atob(standard);
  return { kind: "Bytes", bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)) };
};

/**
 * `Multibase.decode` of a value at most `maxLength` characters long. Base58
 * decoding is quadratic in the length, so a longer value is not decoded: it
 * reads as `Unread`, or as `Malformed` when a linear pass finds a character
 * not of its base, as Mastodon would.
 */
const decode = (text: string, maxLength: number): Decoded => {
  const tooLong = text.length > maxLength;
  const rest = text.slice(1);
  switch (text[0]) {
    case "z":
      return tooLong ? (isBase58(rest) ? UNREAD : MALFORMED) : decodeBase58(rest);
    case "u": {
      const decoded = decodeBase64Url(rest);
      return tooLong && decoded.kind === "Bytes" ? UNREAD : decoded;
    }
    default:
      return UNREAD;
  }
};

/**
 * The bytes of a `z` or `u` multibase string at most `maxLength` characters
 * long (see {@link decode}); `undefined` when Mastodon reads none from it.
 */
export const decodeMultibase = (text: string, maxLength: number): Uint8Array | undefined => {
  const decoded = decode(text, maxLength);
  return decoded.kind === "Bytes" ? decoded.bytes : undefined;
};

/** A public key read from a `publicKeyMultibase`, as SPKI PEM. */
export type MultibaseKey = Readonly<{ kind: "Rsa" | "Ed25519"; publicKeyPem: string }>;

/** The multicodec varint prefixes Mastodon reads (`Multibase::MULTICODEC_PREFIXES`). */
const RSA_PUB = Uint8Array.of(0x85, 0x24);
const ED25519_PUB = Uint8Array.of(0xed, 0x01);

/** `ED25519_PUB_DER_HEADER`: the SPKI prefix of a raw 32-byte Ed25519 key. */
const ED25519_SPKI_HEADER = Uint8Array.of(
  0x30,
  0x2a,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x03,
  0x21,
  0x00,
);

/** The SPKI AlgorithmIdentifier of `rsaEncryption`, with its NULL parameters. */
const RSA_ALGORITHM = Uint8Array.of(
  0x30,
  0x0d,
  0x06,
  0x09,
  0x2a,
  0x86,
  0x48,
  0x86,
  0xf7,
  0x0d,
  0x01,
  0x01,
  0x01,
  0x05,
  0x00,
);

const startsWith = (bytes: Uint8Array, prefix: Uint8Array): boolean =>
  bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);

const derLength = (length: number): Uint8Array => {
  if (length < 0x80) {
    return Uint8Array.of(length);
  }
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) {
    bytes.unshift(rest & 0xff);
  }
  return concat(Uint8Array.of(0x80 | bytes.length), Uint8Array.from(bytes));
};

const der = (tag: number, ...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const body = concat(...parts);
  return concat(Uint8Array.of(tag), derLength(body.length), body);
};

/**
 * The DER element at the start of `bytes`: its tag and where its contents
 * start and end, when its length is one DER can state.
 */
const derElement = (
  bytes: Uint8Array,
  offset: number,
): Readonly<{ tag: number; start: number; end: number }> | undefined => {
  const tag = bytes[offset];
  const first = bytes[offset + 1];
  if (tag === undefined || first === undefined) {
    return undefined;
  }
  if (first < 0x80) {
    return { tag, start: offset + 2, end: offset + 2 + first };
  }
  const count = first & 0x7f;
  if (count === 0 || count > 4) {
    return undefined;
  }
  let length = 0;
  for (let index = 0; index < count; index++) {
    const byte = bytes[offset + 2 + index];
    if (byte === undefined) {
      return undefined;
    }
    length = length * 256 + byte;
  }
  return { tag, start: offset + 2 + count, end: offset + 2 + count + length };
};

/**
 * The SPKI DER of an `rsa-pub` key. The multicodec holds a PKCS#1
 * `RSAPublicKey`; OpenSSL, and so Mastodon, also reads an SPKI there.
 */
const rsaSpki = (key: Uint8Array): Uint8Array | undefined => {
  const outer = derElement(key, 0);
  if (outer === undefined || outer.tag !== 0x30 || outer.end !== key.length) {
    return undefined;
  }
  const inner = derElement(key, outer.start);
  if (inner?.tag === 0x30) {
    return key;
  }
  if (inner?.tag === 0x02) {
    return der(0x30, RSA_ALGORITHM, der(0x03, Uint8Array.of(0x00), key));
  }
  return undefined;
};

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

/** PEM as Ruby's OpenSSL writes an RSA key: base64 in lines of 64. */
const wrappedPem = (spki: Uint8Array): string =>
  `-----BEGIN PUBLIC KEY-----\n${(base64(spki).match(/.{1,64}/g) ?? []).join("\n")}\n-----END PUBLIC KEY-----\n`;

/**
 * What `ProcessAccountService#key_from_multikey` makes of a
 * `publicKeyMultibase`: the key; `NoKey` where `Multibase.decode_key_to_pem`
 * raises `Multibase::Error`, which it rescues, so the key is skipped;
 * `Malformed` where the value is not of its base (an `ArgumentError` it does
 * not rescue), so Mastodon refuses the whole actor.
 */
export type MultibaseKeyRead =
  | Readonly<{ kind: "Key"; key: MultibaseKey }>
  | Readonly<{ kind: "NoKey" }>
  | Readonly<{ kind: "Malformed" }>;

/**
 * `Multibase.decode_key_to_pem`: the RSA or Ed25519 key a
 * `publicKeyMultibase` holds, as SPKI PEM written as Mastodon writes it.
 * Anything else (another codec, an Ed25519 key not 32 bytes long, an RSA key
 * that is not DER) reads as no key. Mastodon also reads `mldsa-44-pub`; no
 * Workers API verifies ML-DSA, so it is read as no key here.
 */
export const multibaseKey = (text: string): MultibaseKeyRead => {
  const decoded = decode(text, MAX_KEY_LENGTH);
  switch (decoded.kind) {
    case "Malformed":
      return { kind: "Malformed" };
    case "Unread":
      return { kind: "NoKey" };
    case "Bytes": {
      const key = keyFromBytes(decoded.bytes);
      return key === undefined ? { kind: "NoKey" } : { kind: "Key", key };
    }
  }
};

/**
 * The longest `publicKeyMultibase` read: a 4096-bit RSA key is about 750
 * base58 characters, an Ed25519 key 48.
 */
const MAX_KEY_LENGTH = 2048;

const keyFromBytes = (bytes: Uint8Array): MultibaseKey | undefined => {
  if (startsWith(bytes, ED25519_PUB)) {
    const key = bytes.subarray(ED25519_PUB.length);
    return key.length === 32
      ? {
          kind: "Ed25519",
          publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${base64(concat(ED25519_SPKI_HEADER, key))}\n-----END PUBLIC KEY-----\n`,
        }
      : undefined;
  }
  if (startsWith(bytes, RSA_PUB)) {
    const spki = rsaSpki(bytes.subarray(RSA_PUB.length));
    return spki === undefined ? undefined : { kind: "Rsa", publicKeyPem: wrappedPem(spki) };
  }
  return undefined;
};
