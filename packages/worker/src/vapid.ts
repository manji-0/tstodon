import { schemaResult } from "@tstodon/core";
import { z } from "zod";

/**
 * The VAPID key pair push services verify our Web Push requests against
 * (RFC 8292). `VAPID_PRIVATE_JWK` is a secret holding a P-256 private JWK;
 * without it the instance advertises no `vapid_key` and sends no pushes.
 */
const VapidJwkSchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().min(1),
  y: z.string().min(1),
  d: z.string().min(1),
});

export type VapidJwk = z.infer<typeof VapidJwkSchema>;

const VapidEnvSchema = z.object({
  VAPID_PRIVATE_JWK: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
});

export type VapidKeys = Readonly<{
  privateJwk: VapidJwk;
  /** The uncompressed public point, base64url (Mastodon's `vapid_key`). */
  publicKey: string;
  /** `mailto:` or `https:` contact for the VAPID JWT `sub` (`VAPID_SUBJECT`), if set. */
  subject: string | undefined;
}>;

export const base64UrlToBytes = (value: string): Uint8Array => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

export const bytesToBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** The configured VAPID keys, or `undefined` when push is not configured. */
export const vapidKeys = (env: Env): VapidKeys | undefined => {
  const vars = schemaResult(VapidEnvSchema)(env);
  if (vars.isErr()) {
    return undefined;
  }
  const raw = (vars.value.VAPID_PRIVATE_JWK ?? "").trim();
  if (raw.length === 0) {
    return undefined;
  }
  const jwk = schemaResult(VapidJwkSchema)(parseJson(raw));
  if (jwk.isErr()) {
    return undefined;
  }
  const x = base64UrlToBytes(jwk.value.x);
  const y = base64UrlToBytes(jwk.value.y);
  const point = new Uint8Array(1 + x.length + y.length);
  point[0] = 0x04;
  point.set(x, 1);
  point.set(y, 1 + x.length);
  const subject = (vars.value.VAPID_SUBJECT ?? "").trim();
  return {
    privateJwk: jwk.value,
    publicKey: bytesToBase64Url(point),
    subject: subject.length > 0 ? subject : undefined,
  };
};

/** Mastodon's `vapid_key`: the public key, or `null` when push is not configured. */
export const vapidPublicKey = (env: Env): string | null => vapidKeys(env)?.publicKey ?? null;
