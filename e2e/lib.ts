import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT, importJWK, type JWK } from "jose";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const A = process.env.E2E_A_ORIGIN ?? "http://127.0.0.1:8791";
export const B = process.env.E2E_B_ORIGIN ?? "http://127.0.0.1:8792";
export const A_DOMAIN = process.env.E2E_A_DOMAIN ?? "127.0.0.1:8791";
export const B_DOMAIN = process.env.E2E_B_DOMAIN ?? "127.0.0.1:8792";

const LOCAL_PRIVATE_JWK = {
  kty: "RSA",
  n: "qHE50MFXgxUeSKwP4ChF1TRN7gvR1z4bRcTIc7Jcr6qTrccio5BjeveN7dxj8pP985tYQMVI9sx81vEA7v38KzY0Q9UqEgZzd7VP_TGJEm4fxaP7dZSVQWTvrTxNpqCCPml4rc3nNgABRWniSgwCWR1A7d7mpOTicxXG6PApWAPDuRGdBNq2hnkm2fkFSKKf_oyaXjlRZJMYiMR8pOoCb9xrSUKTzrUjK_AvSmt3CcnJwMqMMVn_ZP7-nRi-OogwkOjW0NyUzIle7KQkMYDhHGRMUnZjj6Qwo0yBzvJXXuBjusHTPYHPlSVnY4k9uxA2SojnCUgrM20tGLsmUofpFw",
  e: "AQAB",
  kid: "tstodon-local-access",
  alg: "RS256",
  use: "sig",
  d: "AsdDVd8qi134zugPpvnjFP403t1RC8TZfFAfolDp2Hfu0an8N0h1a5zTuX2uJF0ujisczIy0hGWhFYaKJmcIFsphGFFWzU9P7kSOWjXL9gLdAUyQJENcJuT8UxYwjbQOEet5cxx3WNutKbDya5hBHaku3f2UPloMJivQyRzVAb-fRdZR4ImfmfHbeKRgB3TGETAfaR1hJGWSmPEZVOrLBDo6hGoccJ_-4L1j5nCpZVZ2grXOqFqofotZmeB8aGNDaWAe365FmD4vO9iv5p0Yu5s-OPT4sfKkYFhz_59JyoW4mGB0qoYzDgOM_Q5edHKqhZVMOe6GDHEz6qwBVRYnIQ",
  p: "4gAUZ8Fnfjs1bKZk5SR0c7Zh5OUqIMguH63RxfF3pe45P5U7ZLtqdP6SrrMhYbPTrBNsQcQydsVGJgaRyxf553A3QiSP4WYu7cvqHCiJ1dMJj251yVUta2-CFLSDHv3R0bjp4E_1_MgVgfaWTlfk2haRyeahVBq1nMuHUpTUYEc",
  q: "vs03DytptttgweXwU1V8Muv_8J7_-QMBCU-Iypb_wdwLMbVM18CKB0iJKXty2teIvfY7oNOfKZyuJ6GjEEshKQGLZOIF07jRcsc6ckuC69wv6hNR6dF5TG2dWW32lQUM4oCHa7WwZKFYIAM-W-SuFzrgMAbENdTteR-D3tmH6LE",
  dp: "wDdJI6X_HAHHwo0TK0ECOphYUpIGbrNTZ2YzEKP7G4mt70JBrb8pIDCVGTkJn0uPML-kR5tTQGkw7I6R2aaeyhVLKlpmdVKvf1j72M8xzEcdznwoegCUDNheTrXo_6bpmfIoGLxpf4G9qTfNRvzCjCq9_HbHp_y_kogYpEgpCWk",
  dq: "bxayYO2oziMqUZpb81kJR-iqCmG4rTW3i8E35qRF4owIJHfndpKOirEL0xAiDhKBdgCANSIhQCwOJdrxQtJLS0Gv9Bu4ws2PfOFMQTF_121KpGF9RsKEeiA0BdaFQ7w-BT5KGkcdnWlnErRwwTYCulm4H55A7Qq8_NGBiOVkQPE",
  qi: "A3Uy5wXgpeDH9l1qxhKtN_O-3F6Ia_mhWeG6mTaNUlKXjI6cJ4rjdEnQCZaZk8IPGWfDutxG9-FQgklx_TgHFc0jdJGuabtNl3QlYTY-QSsKcfq1qQaRRC-n3CB6MiP-CEm3E-6ufbAE1J2YOqgkfv_sB9WvCWPkzJANZJSbEFk",
} as const satisfies JWK;

export type E2eInstance = "a" | "b";

export type JsonBody = unknown;

export type HttpJsonResult = {
  status: number;
  body: JsonBody;
  headers: Headers;
};

export type D1Row = Record<string, unknown>;

export type ActorDocument = {
  id: string;
  preferredUsername: string;
  inbox: string;
  name?: string;
  endpoints?: {
    sharedInbox?: string;
  };
  publicKey: {
    id: string;
    publicKeyPem: string;
  };
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const asString = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value == null) {
    return "";
  }
  return JSON.stringify(value);
};

export function fail(message: string, detail?: unknown): never {
  console.error(`FAIL: ${message}`, detail ?? "");
  process.exit(1);
}

export const requireUsername = (body: unknown, label: string): string => {
  if (isRecord(body) && typeof body.username === "string") {
    return body.username;
  }
  return fail(label, body);
};

export const asActorDocument = (body: unknown, label: string): ActorDocument => {
  if (!isRecord(body)) {
    return fail(label, body);
  }
  const { id, preferredUsername, inbox, publicKey, name, endpoints } = body;
  if (typeof id !== "string") {
    return fail(label, body);
  }
  if (typeof preferredUsername !== "string") {
    return fail(label, body);
  }
  if (typeof inbox !== "string") {
    return fail(label, body);
  }
  if (!isRecord(publicKey)) {
    return fail(label, body);
  }
  if (typeof publicKey.id !== "string" || typeof publicKey.publicKeyPem !== "string") {
    return fail(label, body);
  }
  const actor: ActorDocument = {
    id,
    preferredUsername,
    inbox,
    publicKey: {
      id: publicKey.id,
      publicKeyPem: publicKey.publicKeyPem,
    },
  };
  if (typeof name === "string") {
    actor.name = name;
  }
  if (isRecord(endpoints) && typeof endpoints.sharedInbox === "string") {
    actor.endpoints = { sharedInbox: endpoints.sharedInbox };
  }
  return actor;
};

export const getJson = async (url: string, init?: RequestInit): Promise<HttpJsonResult> => {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: JsonBody;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
};

export const waitOk = async (url: string, label: string): Promise<void> => {
  for (let i = 0; i < 90; i += 1) {
    try {
      const { status } = await getJson(url);
      if (status === 200) {
        console.log(`ok ${label}`);
        return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`${label} not ready`, url);
};

export const authHeaders = async (email: string): Promise<Record<string, string>> => {
  const key = await importJWK(LOCAL_PRIVATE_JWK, "RS256");
  const token = await new SignJWT({ email, type: "app", groups: [], custom: { groups: [] } })
    .setProtectedHeader({ alg: "RS256", kid: "tstodon-local-access", typ: "JWT" })
    .setIssuer("https://tstodon.cloudflareaccess.com")
    .setAudience("tstodon-local-aud")
    .setSubject(email)
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(key);
  return { Authorization: `Bearer ${token}` };
};

export const d1Json = (instance: E2eInstance, sql: string): D1Row[] => {
  const config = instance === "a" ? "e2e/a.wrangler.jsonc" : "e2e/b.wrangler.jsonc";
  const persist = instance === "a" ? ".wrangler/e2e-a" : ".wrangler/e2e-b";
  const db = instance === "a" ? "tstodon-e2e-a" : "tstodon-e2e-b";
  const raw = execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      db,
      "--local",
      "--config",
      config,
      "--persist-to",
      persist,
      "--json",
      "--command",
      sql,
    ],
    { cwd: root, encoding: "utf8" },
  );
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    if (first && typeof first === "object" && "results" in first) {
      const results = (first as { results?: unknown }).results;
      return Array.isArray(results) ? (results as D1Row[]) : [];
    }
    return [];
  }
  if (parsed && typeof parsed === "object" && "results" in parsed) {
    const results = (parsed as { results?: unknown }).results;
    return Array.isArray(results) ? (results as D1Row[]) : [];
  }
  return [];
};

export const accountPrivateKeyJwk = (instance: E2eInstance, username: string): string => {
  const rows = d1Json(
    instance,
    `SELECT private_key_jwk FROM accounts WHERE username = '${username.replaceAll("'", "''")}' LIMIT 1`,
  );
  const jwk = rows[0]?.private_key_jwk;
  if (typeof jwk === "string") {
    return jwk;
  }
  return fail(`private key missing for ${username} on ${instance}`, rows);
};

const sha256DigestHeader = async (body: string): Promise<string> => {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const bytes = new Uint8Array(hash);
  return `SHA-256=${btoa(String.fromCharCode(...bytes))}`;
};

export const signInboxPost = async (
  inboxUrl: string,
  privateKeyJwkJson: string,
  keyId: string,
  body: string,
): Promise<Record<string, string>> => {
  const url = new URL(inboxUrl);
  const digest = await sha256DigestHeader(body);
  const date = new Date().toUTCString();
  const headerNames = ["(request-target)", "host", "date", "digest"];
  const signingString = [
    `(request-target): post ${url.pathname}${url.search}`,
    `host: ${url.host}`,
    `date: ${date}`,
    `digest: ${digest}`,
  ].join("\n");
  const jwk = JSON.parse(privateKeyJwkJson) as {
    kty: string;
    n?: string;
    e?: string;
    d?: string;
    p?: string;
    q?: string;
    dp?: string;
    dq?: string;
    qi?: string;
  };
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
    new TextEncoder().encode(signingString),
  );
  const bytes = new Uint8Array(signature);
  const signatureHeader = `keyId="${keyId}",algorithm="rsa-sha256",headers="${headerNames.join(" ")}",signature="${btoa(String.fromCharCode(...bytes))}"`;
  return {
    Host: url.host,
    Date: date,
    Digest: digest,
    Signature: signatureHeader,
    "Content-Type": "application/activity+json",
  };
};

export const postSignedInbox = async (
  inboxUrl: string,
  privateKeyJwkJson: string,
  keyId: string,
  activity: unknown,
): Promise<HttpJsonResult> => {
  const body = JSON.stringify(activity);
  const headers = await signInboxPost(inboxUrl, privateKeyJwkJson, keyId, body);
  return getJson(inboxUrl, { method: "POST", headers, body });
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const waitRows = async (
  instance: E2eInstance,
  sql: string,
  predicate: (rows: D1Row[]) => boolean,
  label: string,
  attempts = 30,
): Promise<D1Row[]> => {
  for (let i = 0; i < attempts; i += 1) {
    const rows = d1Json(instance, sql);
    if (predicate(rows)) {
      return rows;
    }
    await sleep(500);
  }
  return fail(label, d1Json(instance, sql));
};

/** Seed a remote actor row so inbox verification can skip loopback fetch (workerd blocks 127.0.0.1). */
export const seedRemoteActor = (instance: E2eInstance, actor: ActorDocument): void => {
  const shared = actor.endpoints?.sharedInbox
    ? `'${String(actor.endpoints.sharedInbox).replaceAll("'", "''")}'`
    : "NULL";
  const now = new Date().toISOString();
  const sql = `INSERT INTO remote_actors (
      actor_uri, username, domain, inbox_uri, shared_inbox_uri,
      public_key_id, public_key_pem, display_name, fetched_at, created_at, updated_at
    ) VALUES (
      '${actor.id.replaceAll("'", "''")}',
      '${String(actor.preferredUsername).replaceAll("'", "''")}',
      '${String(new URL(actor.id).host).replaceAll("'", "''")}',
      '${String(actor.inbox).replaceAll("'", "''")}',
      ${shared},
      '${String(actor.publicKey.id).replaceAll("'", "''")}',
      '${String(actor.publicKey.publicKeyPem).replaceAll("'", "''")}',
      '${String(actor.name ?? actor.preferredUsername).replaceAll("'", "''")}',
      '${now}', '${now}', '${now}'
    )
    ON CONFLICT(actor_uri) DO UPDATE SET
      public_key_id = excluded.public_key_id,
      public_key_pem = excluded.public_key_pem,
      inbox_uri = excluded.inbox_uri,
      shared_inbox_uri = excluded.shared_inbox_uri,
      updated_at = excluded.updated_at`;
  d1Json(instance, sql);
};
