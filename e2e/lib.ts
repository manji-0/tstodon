import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { schemaResult, type ValidationError } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import { softPasskey } from "../packages/worker/test/soft-passkey.js";
import {
  AccountPrivateKeyRow,
  ApPerson,
  MastodonAccount,
  type ApPerson as ApPersonValue,
  type MastodonAccount as MastodonAccountValue,
} from "./schemas.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const A = process.env.E2E_A_ORIGIN ?? "http://127.0.0.1:8791";
export const B = process.env.E2E_B_ORIGIN ?? "http://127.0.0.1:8792";
export const A_DOMAIN = process.env.E2E_A_DOMAIN ?? "127.0.0.1:8791";
export const B_DOMAIN = process.env.E2E_B_DOMAIN ?? "127.0.0.1:8792";

const PrivateKeyJwkSchema = z
  .object({
    kty: z.string().min(1),
    n: z.string().optional(),
    e: z.string().optional(),
    d: z.string().optional(),
    p: z.string().optional(),
    q: z.string().optional(),
    dp: z.string().optional(),
    dq: z.string().optional(),
    qi: z.string().optional(),
  })
  .passthrough();
const parsePrivateKeyJwk = schemaResult(PrivateKeyJwkSchema);

const d1ExecuteRowSchema = z.object({ results: z.array(z.unknown()).optional() }).passthrough();
const d1ExecuteEnvelopeSchema = z.union([z.array(d1ExecuteRowSchema), d1ExecuteRowSchema]);
const parseD1ExecuteEnvelope = schemaResult(d1ExecuteEnvelopeSchema);

export type E2eInstance = "a" | "b";

export type JsonBody = unknown;

export type HttpJsonResult = {
  status: number;
  body: JsonBody;
  headers: Headers;
};

export type ActorDocument = ApPersonValue;

export function fail(message: string, detail?: unknown): never {
  console.error(`FAIL: ${message}`, detail ?? "");
  process.exit(1);
}

export const expectParsed = <T>(
  label: string,
  parse: (raw: unknown) => Result<T, ValidationError>,
  raw: unknown,
): T => {
  const parsed = parse(raw);
  if (parsed.isErr()) {
    return fail(label, parsed.error);
  }
  return parsed.value;
};

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

export const getJsonParsed = async <T>(
  url: string,
  parse: (raw: unknown) => Result<T, ValidationError>,
  label: string,
  init?: RequestInit,
): Promise<{ status: number; body: T; headers: Headers }> => {
  const result = await getJson(url, init);
  const body = expectParsed(label, parse, result.body);
  return { status: result.status, body, headers: result.headers };
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

/** The captured confirmation email for `email` on an e2e instance (`EMAIL_TRANSPORT=capture`). */
const mailboxText = (instance: E2eInstance, email: string): string => {
  const config = instance === "a" ? "e2e/a.wrangler.jsonc" : "e2e/b.wrangler.jsonc";
  const persist = instance === "a" ? ".wrangler/e2e-a" : ".wrangler/e2e-b";
  return execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "kv",
      "key",
      "get",
      `mailbox:${email.toLowerCase()}`,
      "--binding",
      "APP_CACHE",
      "--local",
      "--config",
      config,
      "--persist-to",
      persist,
    ],
    { cwd: root, encoding: "utf8" },
  );
};

/** A cookie-keeping client for one instance: what a browser does during sign-up. */
const browserFor = (origin: string) => {
  const cookies = new Map<string, string>();
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookies.size > 0) {
      headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    if (init.method !== undefined && init.method !== "GET") {
      headers.set("origin", origin);
    }
    const response = await fetch(`${origin}${path}`, { ...init, headers, redirect: "manual" });
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const separator = pair.indexOf("=");
      cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
    return response;
  };
};

const RegistrationOptions = z.object({
  challenge: z.string(),
  rp: z.object({ id: z.string().optional() }),
});
const RegisteredApp = z.object({ client_id: z.string(), client_secret: z.string() });
const IssuedToken = z.object({ access_token: z.string() });

const OOB = "urn:ietf:wg:oauth:2.0:oob";

/**
 * Sign up on `origin` (confirm the email link, then a software passkey), authorize an app through the
 * consent page, and return its bearer token. The username is the email's
 * local part, sanitized as account usernames are.
 */
export const authHeaders = async (
  origin: string,
  email: string,
): Promise<Record<string, string>> => {
  const username = (email.split("@")[0] ?? "")
    .toLowerCase()
    .replaceAll("-", "_")
    .replace(/[^a-z0-9_]/g, "");
  const browser = browserFor(origin);
  const requested = await browser("/auth/sign_up", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, email }).toString(),
  });
  if (!requested.ok) {
    return fail(`sign-up request for ${username} on ${origin}`, await requested.text());
  }
  // The e2e instances capture mail in APP_CACHE instead of sending it.
  const mail = mailboxText(origin === A ? "a" : "b", email);
  const linkToken = /\/auth\/sign_up\/verify\?token=([\w-]+)/.exec(mail)?.[1];
  if (!linkToken) {
    return fail(`sign-up link for ${username} on ${origin}`, mail);
  }
  const options = await browser(
    `/api/auth/passkey/generate-register-options?${new URLSearchParams({ context: linkToken, name: username }).toString()}`,
  );
  if (!options.ok) {
    return fail(`sign-up options for ${username} on ${origin}`, await options.text());
  }
  const passkey = await softPasskey(origin);
  const registration = await passkey.register(
    expectParsed("registration options", schemaResult(RegistrationOptions), await options.json()),
  );
  const verified = await browser("/api/auth/passkey/verify-registration", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response: registration, createSession: true }),
  });
  if (!verified.ok) {
    return fail(`passkey sign-up for ${username} on ${origin}`, await verified.text());
  }
  const appResponse = await fetch(`${origin}/api/v1/apps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "tstodon e2e",
      redirect_uris: OOB,
      scopes: "read write follow push",
    }),
  });
  const app = expectParsed(
    "app registration",
    schemaResult(RegisteredApp),
    await appResponse.json(),
  );
  const consent = await browser("/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: app.client_id,
      redirect_uri: OOB,
      scope: "read write follow push",
      decision: "approve",
    }).toString(),
  });
  const code = /<code>([^<]+)<\/code>/.exec(await consent.text())?.[1];
  if (!consent.ok || !code) {
    return fail(`OAuth consent for ${username} on ${origin}`, consent.status);
  }
  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: app.client_id,
      client_secret: app.client_secret,
      redirect_uri: OOB,
      code,
    }),
  });
  const token = expectParsed("token", schemaResult(IssuedToken), await tokenResponse.json());
  return { Authorization: `Bearer ${token.access_token}` };
};

const unwrapD1Results = (raw: unknown): unknown[] => {
  const parsed = parseD1ExecuteEnvelope(raw);
  if (parsed.isErr()) {
    return fail("wrangler d1 --json envelope", parsed.error);
  }
  const value = parsed.value;
  if (Array.isArray(value)) {
    return value[0]?.results ?? [];
  }
  return value.results ?? [];
};

export const d1Json = (instance: E2eInstance, sql: string): unknown[] => {
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
  return unwrapD1Results(JSON.parse(raw));
};

export const d1Rows = <T>(
  instance: E2eInstance,
  sql: string,
  parseMany: (raw: unknown) => Result<T[], ValidationError>,
  label: string,
): T[] => expectParsed(label, parseMany, d1Json(instance, sql));

export const accountPrivateKeyJwk = (instance: E2eInstance, username: string): string => {
  const rows = d1Json(
    instance,
    `SELECT private_key_jwk FROM accounts WHERE username = '${username.replaceAll("'", "''")}' LIMIT 1`,
  );
  const row = expectParsed(
    `private key missing for ${username} on ${instance}`,
    AccountPrivateKeyRow.parse,
    rows[0],
  );
  return row.private_key_jwk;
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
  const jwkParsed = expectParsed(
    "account private key jwk",
    parsePrivateKeyJwk,
    JSON.parse(privateKeyJwkJson),
  );
  const jwkData: JsonWebKey = { kty: jwkParsed.kty };
  if (jwkParsed.n !== undefined) jwkData.n = jwkParsed.n;
  if (jwkParsed.e !== undefined) jwkData.e = jwkParsed.e;
  if (jwkParsed.d !== undefined) jwkData.d = jwkParsed.d;
  if (jwkParsed.p !== undefined) jwkData.p = jwkParsed.p;
  if (jwkParsed.q !== undefined) jwkData.q = jwkParsed.q;
  if (jwkParsed.dp !== undefined) jwkData.dp = jwkParsed.dp;
  if (jwkParsed.dq !== undefined) jwkData.dq = jwkParsed.dq;
  if (jwkParsed.qi !== undefined) jwkData.qi = jwkParsed.qi;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwkData,
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

export const waitRows = async <T>(
  instance: E2eInstance,
  sql: string,
  parseMany: (raw: unknown) => Result<T[], ValidationError>,
  predicate: (rows: T[]) => boolean,
  label: string,
  attempts = 30,
): Promise<T[]> => {
  for (let i = 0; i < attempts; i += 1) {
    const rows = d1Rows(instance, sql, parseMany, label);
    if (predicate(rows)) {
      return rows;
    }
    await sleep(500);
  }
  return fail(label, d1Rows(instance, sql, parseMany, label));
};

export const fetchMastodonAccount = async (
  origin: string,
  headers: Record<string, string>,
  label: string,
): Promise<MastodonAccountValue> => {
  const result = await getJsonParsed(
    `${origin}/api/v1/accounts/verify_credentials`,
    MastodonAccount.parse,
    label,
    { headers },
  );
  if (result.status !== 200) {
    return fail(label, result);
  }
  return result.body;
};

export const fetchApPerson = async (actorUrl: string, label: string): Promise<ApPersonValue> => {
  const result = await getJsonParsed(actorUrl, ApPerson.parse, label, {
    headers: { Accept: "application/activity+json" },
  });
  if (result.status !== 200) {
    return fail(label, result);
  }
  return result.body;
};

/** Seed a remote actor row so inbox verification can skip loopback fetch (workerd blocks 127.0.0.1). */
export const seedRemoteActor = (instance: E2eInstance, actor: ActorDocument): void => {
  const shared = actor.endpoints?.sharedInbox
    ? `'${actor.endpoints.sharedInbox.replaceAll("'", "''")}'`
    : "NULL";
  const now = new Date().toISOString();
  const sql = `INSERT INTO remote_actors (
      actor_uri, username, domain, inbox_uri, shared_inbox_uri,
      public_key_id, public_key_pem, display_name, fetched_at, created_at, updated_at
    ) VALUES (
      '${actor.id.replaceAll("'", "''")}',
      '${actor.preferredUsername.replaceAll("'", "''")}',
      '${new URL(actor.id).host.replaceAll("'", "''")}',
      '${actor.inbox.replaceAll("'", "''")}',
      ${shared},
      '${actor.publicKey.id.replaceAll("'", "''")}',
      '${actor.publicKey.publicKeyPem.replaceAll("'", "''")}',
      '${(actor.name ?? actor.preferredUsername).replaceAll("'", "''")}',
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
