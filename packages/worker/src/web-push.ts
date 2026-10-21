import { SignJWT, importJWK } from "jose";
import { base64UrlToBytes, bytesToBase64Url, type VapidKeys } from "./vapid";

/**
 * Web Push message encryption and VAPID signing, on WebCrypto only.
 *
 * `standard` subscriptions get RFC 8291 (`aes128gcm`) with RFC 8292 VAPID
 * (`Authorization: vapid t=…, k=…`); the others get the earlier draft Mastodon
 * still sends by default (`aesgcm`, draft-ietf-webpush-encryption-04) with the
 * key in `Crypto-Key` and `Authorization: WebPush …`.
 */

export type PushTarget = Readonly<{
  endpoint: string;
  p256dh: string;
  auth: string;
  standard: boolean;
}>;

export type EncryptedPush = Readonly<{
  body: Uint8Array;
  headers: Readonly<Record<string, string>>;
}>;

const encoder = new TextEncoder();

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** HKDF-SHA-256 extract-and-expand to `length` bytes. */
const hkdf = async (
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8),
  );
};

/** A fresh sender key pair, its raw public point, and the ECDH secret with the subscriber. */
const agree = async (
  subscriberPublic: Uint8Array,
): Promise<{ senderPublic: Uint8Array; secret: Uint8Array }> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  if (!("privateKey" in pair)) {
    throw new Error("ECDH key generation returned a single key");
  }
  const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(exported instanceof ArrayBuffer)) {
    throw new Error("ECDH public key did not export as raw bytes");
  }
  const peer = await crypto.subtle.importKey(
    "raw",
    subscriberPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  // workerd reads `public`; its generated types spell the reserved word `$public`,
  // so the algorithm goes through a variable rather than an object literal.
  const algorithm = { name: "ECDH", public: peer };
  const secret = new Uint8Array(await crypto.subtle.deriveBits(algorithm, pair.privateKey, 256));
  return { senderPublic: new Uint8Array(exported), secret };
};

const aesGcm = async (key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array) => {
  const cek = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cek, plaintext),
  );
};

const RECORD_SIZE = 4096;

/** RFC 8291: one `aes128gcm` record, header carrying the salt and sender key. */
export const encryptAes128gcm = async (
  target: Pick<PushTarget, "p256dh" | "auth">,
  payload: Uint8Array,
): Promise<Uint8Array> => {
  const subscriberPublic = base64UrlToBytes(target.p256dh);
  const authSecret = base64UrlToBytes(target.auth);
  const { senderPublic, secret } = await agree(subscriberPublic);
  const ikm = await hkdf(
    authSecret,
    secret,
    concat(encoder.encode("WebPush: info\0"), subscriberPublic, senderPublic),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  // A single (and so last) record ends with the 0x02 delimiter.
  const ciphertext = await aesGcm(cek, nonce, concat(payload, new Uint8Array([0x02])));
  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublic.length;
  return concat(header, senderPublic, ciphertext);
};

const lengthPrefixed = (key: Uint8Array): Uint8Array => {
  const prefix = new Uint8Array(2);
  new DataView(prefix.buffer).setUint16(0, key.length);
  return concat(prefix, key);
};

/** draft-04 `aesgcm`: salt and sender key travel in the `Encryption`/`Crypto-Key` headers. */
export const encryptAesgcm = async (
  target: Pick<PushTarget, "p256dh" | "auth">,
  payload: Uint8Array,
): Promise<{ ciphertext: Uint8Array; salt: Uint8Array; senderPublic: Uint8Array }> => {
  const subscriberPublic = base64UrlToBytes(target.p256dh);
  const authSecret = base64UrlToBytes(target.auth);
  const { senderPublic, secret } = await agree(subscriberPublic);
  const ikm = await hkdf(authSecret, secret, encoder.encode("Content-Encoding: auth\0"), 32);
  const context = concat(
    encoder.encode("P-256\0"),
    lengthPrefixed(subscriberPublic),
    lengthPrefixed(senderPublic),
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(
    salt,
    ikm,
    concat(encoder.encode("Content-Encoding: aesgcm\0"), context),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    concat(encoder.encode("Content-Encoding: nonce\0"), context),
    12,
  );
  // Two bytes of padding length (none), then the payload.
  const ciphertext = await aesGcm(cek, nonce, concat(new Uint8Array(2), payload));
  return { ciphertext, salt, senderPublic };
};

/** The ES256 VAPID token for the push service at `endpoint`'s origin, valid for 12 hours. */
export const vapidToken = async (vapid: VapidKeys, endpoint: string, subject: string) => {
  const key = await importJWK(vapid.privateJwk, "ES256");
  return new SignJWT({ sub: subject })
    .setProtectedHeader({ typ: "JWT", alg: "ES256" })
    .setAudience(new URL(endpoint).origin)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 12 * 60 * 60)
    .sign(key);
};

/** The encrypted body and the headers a push service needs for `target`. */
export const buildPushRequest = async (
  vapid: VapidKeys,
  subject: string,
  target: PushTarget,
  payload: string,
  ttlSeconds: number,
): Promise<EncryptedPush> => {
  const bytes = encoder.encode(payload);
  const token = await vapidToken(vapid, target.endpoint, subject);
  const common = {
    "content-type": "application/octet-stream",
    ttl: String(ttlSeconds),
    urgency: "normal",
  };
  if (target.standard) {
    return {
      body: await encryptAes128gcm(target, bytes),
      headers: {
        ...common,
        "content-encoding": "aes128gcm",
        authorization: `vapid t=${token}, k=${vapid.publicKey}`,
      },
    };
  }
  const { ciphertext, salt, senderPublic } = await encryptAesgcm(target, bytes);
  return {
    body: ciphertext,
    headers: {
      ...common,
      "content-encoding": "aesgcm",
      encryption: `salt=${bytesToBase64Url(salt)}`,
      "crypto-key": `dh=${bytesToBase64Url(senderPublic)};p256ecdsa=${vapid.publicKey}`,
      authorization: `WebPush ${token}`,
    },
  };
};
