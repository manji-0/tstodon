import { env } from "cloudflare:test";
import { format, inspect } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { signedInAccount } from "../test/auth-fixture";
import { findAccountById } from "./account-store";
import { listSessions } from "./account-security-store";
import { instanceActorKeys } from "./instance-actor";
import { vapidKeys } from "./vapid";

/** Every way a value usually reaches a log line or a response body. */
const printed = (value: unknown): string =>
  [
    JSON.stringify(value),
    String(value),
    inspect(value, { depth: 10 }),
    format("%s %o %O %j", value, value, value, value),
  ].join("\n");

const privateExponent = (jwk: string): string => {
  const d = /"d":"([^"]+)"/.exec(jwk)?.[1];
  expect(d).toBeTruthy();
  return d ?? "";
};

describe("Sensitive values read from D1 and the environment", () => {
  it("keeps an account's address and private key out of logs and JSON", async () => {
    const email = "pii-redaction@example.com";
    const created = await signedInAccount(email);
    const found = await findAccountById(env.DB, created.id);
    const account = found.isOk() ? found.value : undefined;
    expect(account?.accessEmail.reveal()).toBe(email);
    const d = privateExponent(account?.privateKeyJwk.reveal() ?? "");

    const output = printed(account);
    expect(output).toContain("[REDACTED]");
    expect(output).toContain(account?.username);
    expect(output).not.toContain(email);
    expect(output).not.toContain(d);
  });

  it("keeps the instance actor's private key out of logs and JSON", async () => {
    const keys = await instanceActorKeys(env.DB);
    expect(keys.isOk()).toBe(true);
    if (keys.isErr()) {
      return;
    }
    const output = printed(keys.value);
    expect(output).toContain(keys.value.publicKeyPem.split("\n")[1]);
    expect(output).not.toContain(privateExponent(keys.value.privateKeyJwk.reveal()));
  });

  it("keeps the VAPID private key out of logs and JSON", () => {
    const vapid = vapidKeys(env);
    expect(vapid?.privateJwk.reveal().d).toBeTruthy();
    const output = printed(vapid);
    expect(output).toContain(vapid?.publicKey);
    expect(output).not.toContain(vapid?.privateJwk.reveal().d);
  });

  it("keeps a session's IP address out of logs and JSON", async () => {
    const userId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role)
         VALUES (?, 'ip', 'pii-ip@example.com', 1, ?, ?, 'user')`,
      ).bind(userId, now, now),
      env.DB.prepare(
        `INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, ipAddress, userId)
         VALUES (?, ?, ?, ?, ?, ' 203.0.113.7 ', ?)`,
      ).bind(crypto.randomUUID(), now + 60_000, crypto.randomUUID(), now, now, userId),
    ]);
    const sessions = await listSessions(env.DB, userId, now);
    const session = sessions.isOk() ? sessions.value[0] : undefined;
    expect(session?.ipAddress?.reveal()).toBe("203.0.113.7");
    expect(printed(sessions)).not.toContain("203.0.113.7");
  });
});
