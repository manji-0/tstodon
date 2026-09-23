import { err, ok, type Result } from "neverthrow";
import { parseJsonColumn, RsaPrivateJwkSchema } from "./schemas";

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

export const signInboxRequest = async (
  url: URL,
  privateKeyJwk: string,
  keyId: string,
  body: string,
): Promise<Result<Headers, SignatureError>> => {
  const digest = await sha256DigestHeader(body);
  const date = new Date().toUTCString();
  const headers = ["(request-target)", "host", "date", "digest"];
  const signingString = buildSigningString("post", url.pathname + url.search, headers, {
    host: url.host,
    date,
    digest,
  });
  const parsed = parseJsonColumn(RsaPrivateJwkSchema, privateKeyJwk);
  if (parsed.isErr()) {
    return err({ kind: "InvalidSignature", message: parsed.error.message });
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
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingString),
  );
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const signatureHeader = `keyId="${keyId}",algorithm="rsa-sha256",headers="${headers.join(" ")}",signature="${btoa(binary)}"`;
  return ok(
    new Headers({
      Host: url.host,
      Date: date,
      Digest: digest,
      Signature: signatureHeader,
      "Content-Type": "application/activity+json",
    }),
  );
};

export type ParsedSignature = Readonly<{
  keyId: string;
  algorithm: string;
  headers: ReadonlyArray<string>;
  signature: string;
}>;

export const parseSignatureHeader = (header: string): ParsedSignature | undefined => {
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
    keyId,
    algorithm,
    headers: headers.split(" ").filter((name) => name.length > 0),
    signature,
  };
};

const pemToSpki = (pem: string): ArrayBuffer => {
  const b64 = pem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

const bytesFromB64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

export const verifyInboxRequest = async (
  request: Request,
  publicKeyPem: string,
  body: string,
): Promise<boolean> => {
  const header = request.headers.get("Signature");
  if (!header) {
    return false;
  }
  const parsed = parseSignatureHeader(header);
  if (!parsed) {
    return false;
  }
  const url = new URL(request.url);
  const digest = request.headers.get("Digest");
  const expectedDigest = await sha256DigestHeader(body);
  if (digest !== expectedDigest) {
    return false;
  }
  const headerValues: Record<string, string> = {
    host: request.headers.get("Host") ?? url.host,
    date: request.headers.get("Date") ?? "",
    digest: digest ?? "",
  };
  const signingString = buildSigningString(
    request.method,
    url.pathname + url.search,
    parsed.headers,
    headerValues,
  );
  const key = await crypto.subtle.importKey(
    "spki",
    pemToSpki(publicKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    bytesFromB64(parsed.signature),
    encoder.encode(signingString),
  );
};
