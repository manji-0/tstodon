import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { bytesToBase64Url } from "./vapid";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const SubscriptionSchema = z.object({
  id: z.number().int().positive(),
  endpoint: z.string(),
  standard: z.boolean(),
  alerts: z.record(z.string(), z.boolean()),
  policy: z.string(),
  server_key: z.string().min(1),
});

/** A subscriber's P-256 public key and auth secret, as a browser hands them out. */
const subscriberKeys = async (): Promise<{ p256dh: string; auth: string }> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  if (!("publicKey" in pair)) {
    throw new Error("expected a key pair");
  }
  const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(exported instanceof ArrayBuffer)) {
    throw new Error("expected raw key bytes");
  }
  const raw = new Uint8Array(exported);
  return {
    p256dh: bytesToBase64Url(raw),
    auth: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
};

const form = (fields: Record<string, string>): URLSearchParams => new URLSearchParams(fields);

const subscribe = async (
  email: string,
  fields: Record<string, string>,
  options: { admin?: boolean } = {},
) =>
  json("/api/v1/push/subscription", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(await authHeaders(email, options)),
    },
    body: form(fields),
  });

describe("push subscriptions", () => {
  it("advertises the VAPID public key", async () => {
    const app = await json("/api/v1/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "push-test",
        redirect_uris: "urn:ietf:wg:oauth:2.0:oob",
      }),
    });
    const vapidKey = read(z.object({ vapid_key: z.string().min(1) }), app.body).vapid_key;
    // An uncompressed P-256 point: 65 bytes, base64url without padding.
    expect(vapidKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);

    const instance = await json("/api/v2/instance");
    expect(
      read(
        z.object({ configuration: z.object({ vapid: z.object({ public_key: z.string() }) }) }),
        instance.body,
      ).configuration.vapid.public_key,
    ).toBe(vapidKey);
  });

  it("creates, reads, updates, and deletes a subscription", async () => {
    const email = "push-crud@example.com";
    const headers = await authHeaders(email);
    expect((await json("/api/v1/push/subscription", { headers })).status).toBe(404);

    const keys = await subscriberKeys();
    const created = await subscribe(email, {
      "subscription[endpoint]": "https://push.example/send/one",
      "subscription[keys][p256dh]": keys.p256dh,
      "subscription[keys][auth]": keys.auth,
      "subscription[standard]": "true",
      "data[alerts][mention]": "true",
      "data[alerts][favourite]": "1",
      "data[alerts][admin.sign_up]": "true",
      "data[policy]": "followed",
    });
    expect(created.status).toBe(200);
    const subscription = read(SubscriptionSchema, created.body);
    expect(subscription.endpoint).toBe("https://push.example/send/one");
    expect(subscription.standard).toBe(true);
    expect(subscription.policy).toBe("followed");
    expect(subscription.alerts.mention).toBe(true);
    expect(subscription.alerts.favourite).toBe(true);
    expect(subscription.alerts.reblog).toBe(false);
    expect(subscription.alerts.quote).toBe(false);
    // Admin alerts need an admin.
    expect(subscription.alerts["admin.sign_up"]).toBe(false);

    const fetched = await json("/api/v1/push/subscription", { headers });
    expect(read(SubscriptionSchema, fetched.body)).toEqual(subscription);

    // The same endpoint replaces the subscription it already has.
    const again = await subscribe(email, {
      "subscription[endpoint]": "https://push.example/send/one",
      "subscription[keys][p256dh]": keys.p256dh,
      "subscription[keys][auth]": keys.auth,
      "data[alerts][reblog]": "true",
    });
    const replaced = read(SubscriptionSchema, again.body);
    expect(replaced.id).toBe(subscription.id);
    expect(replaced.alerts.reblog).toBe(true);
    expect(replaced.alerts.mention).toBe(false);
    expect(replaced.policy).toBe("all");

    // PUT changes only the data: alerts left out turn off.
    const updated = await json("/api/v1/push/subscription", {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ data: { alerts: { follow: true } }, policy: "follower" }),
    });
    expect(updated.status).toBe(200);
    const after = read(SubscriptionSchema, updated.body);
    expect(after.alerts.follow).toBe(true);
    expect(after.alerts.reblog).toBe(false);
    expect(after.policy).toBe("follower");
    expect(after.endpoint).toBe("https://push.example/send/one");

    expect((await json("/api/v1/push/subscription", { method: "DELETE", headers })).status).toBe(
      200,
    );
    expect((await json("/api/v1/push/subscription", { headers })).status).toBe(404);
    // Deleting when nothing is there still succeeds.
    expect((await json("/api/v1/push/subscription", { method: "DELETE", headers })).status).toBe(
      200,
    );
    expect(
      (
        await json("/api/v1/push/subscription", {
          method: "PUT",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ data: { alerts: { follow: true } } }),
        })
      ).status,
    ).toBe(404);
  });

  it("keeps one subscription per endpoint and reports the latest", async () => {
    const email = "push-devices@example.com";
    const first = await subscriberKeys();
    const second = await subscriberKeys();
    const one = read(
      SubscriptionSchema,
      (
        await subscribe(email, {
          "subscription[endpoint]": "https://push.example/device/a",
          "subscription[keys][p256dh]": first.p256dh,
          "subscription[keys][auth]": first.auth,
        })
      ).body,
    );
    const two = read(
      SubscriptionSchema,
      (
        await json("/api/v1/push/subscription", {
          method: "POST",
          headers: { "content-type": "application/json", ...(await authHeaders(email)) },
          body: JSON.stringify({
            subscription: { endpoint: "https://push.example/device/b", keys: second },
            data: { alerts: { poll: true } },
          }),
        })
      ).body,
    );
    expect(two.id).not.toBe(one.id);
    expect(two.alerts.poll).toBe(true);
    const latest = await json("/api/v1/push/subscription", {
      headers: await authHeaders(email),
    });
    expect(read(SubscriptionSchema, latest.body).endpoint).toBe("https://push.example/device/b");
  });

  it("lets an admin subscribe to admin alerts", async () => {
    const keys = await subscriberKeys();
    const created = await subscribe(
      "push-admin@example.com",
      {
        "subscription[endpoint]": "https://push.example/admin",
        "subscription[keys][p256dh]": keys.p256dh,
        "subscription[keys][auth]": keys.auth,
        "data[alerts][admin.report]": "true",
      },
      { admin: true },
    );
    expect(read(SubscriptionSchema, created.body).alerts["admin.report"]).toBe(true);
  });

  it("rejects bad endpoints, keys, and policies", async () => {
    const email = "push-invalid@example.com";
    const keys = await subscriberKeys();
    const base = {
      "subscription[endpoint]": "https://push.example/ok",
      "subscription[keys][p256dh]": keys.p256dh,
      "subscription[keys][auth]": keys.auth,
    };
    expect(
      (await subscribe(email, { ...base, "subscription[endpoint]": "http://push.example/plain" }))
        .status,
    ).toBe(422);
    expect(
      (await subscribe(email, { ...base, "subscription[endpoint]": "https://127.0.0.1/push" }))
        .status,
    ).toBe(422);
    expect(
      (await subscribe(email, { ...base, "subscription[endpoint]": "not a url" })).status,
    ).toBe(422);
    expect(
      (await subscribe(email, { ...base, "subscription[keys][auth]": "c2hvcnQ" })).status,
    ).toBe(422);
    expect(
      (await subscribe(email, { ...base, "subscription[keys][p256dh]": keys.auth })).status,
    ).toBe(422);
    expect((await subscribe(email, { ...base, "data[policy]": "everyone" })).status).toBe(422);
    expect(
      (await subscribe(email, { "subscription[endpoint]": "https://push.example/ok" })).status,
    ).toBe(400);
    expect(
      (
        await json("/api/v1/push/subscription", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form(base),
        })
      ).status,
    ).toBe(401);
  });
});
