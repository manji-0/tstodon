/**
 * Multibase values as Mastodon's `Multibase` reads them: base58btc (`z`) and
 * base64url (`u`), the two bases FEP-521a keys and FEP-8b32 proofs use, and
 * the multicodec-tagged public keys (`publicKeyMultibase`) it turns into PEM.
 */

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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

const base58Digits: ReadonlyMap<string, number> = new Map(
  BASE58_ALPHABET.split("").map((char, index) => [char, index]),
);

/** Bitcoin-alphabet base58, as the `base58` gem decodes it: each leading `1` is a zero byte. */
const decodeBase58 = (text: string): Uint8Array | undefined => {
  let value = 0n;
  for (const char of text) {
    const digit = base58Digits.get(char);
    if (digit === undefined) {
      return undefined;
    }
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  const zeros = /^1*/.exec(text)?.[0].length ?? 0;
  return concat(new Uint8Array(zeros), Uint8Array.from(bytes));
};

/** Base64url with or without padding, as Ruby's `Base64.urlsafe_decode64` reads it. */
const decodeBase64Url = (text: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) {
    return undefined;
  }
  const unpadded = text.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) {
    return undefined;
  }
  try {
    const binary = atob(unpadded.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

/**
 * `Multibase.decode`: the bytes of a `z` or `u` multibase string, when it is
 * at most `maxLength` characters long. Base58 decoding is quadratic in the
 * length, so the caller caps it at what the value it reads can be (a key, a
 * signature) before anything is decoded.
 */
export const decodeMultibase = (text: string, maxLength: number): Uint8Array | undefined => {
  if (text.length > maxLength) {
    return undefined;
  }
  switch (text[0]) {
    case "z":
      return decodeBase58(text.slice(1));
    case "u":
      return decodeBase64Url(text.slice(1));
    default:
      return undefined;
  }
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
 * `Multibase.decode_key_to_pem`: the RSA or Ed25519 key a
 * `publicKeyMultibase` holds, as SPKI PEM written as Mastodon writes it.
 * Anything else (another codec, an Ed25519 key not 32 bytes long, an RSA key
 * that is not DER) reads as no key. Mastodon also reads `mldsa-44-pub`; no
 * Workers API verifies ML-DSA, so it is read as no key here.
 */
export const multibaseKey = (text: string): MultibaseKey | undefined => {
  try {
    return keyFromBytes(decodeMultibase(text, MAX_KEY_LENGTH));
  } catch {
    return undefined;
  }
};

/**
 * The longest `publicKeyMultibase` read: a 4096-bit RSA key is about 750
 * base58 characters, an Ed25519 key 48.
 */
const MAX_KEY_LENGTH = 2048;

const keyFromBytes = (bytes: Uint8Array | undefined): MultibaseKey | undefined => {
  if (bytes === undefined) {
    return undefined;
  }
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
