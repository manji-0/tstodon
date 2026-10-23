import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { importJWK, jwtVerify } from "jose";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { processPushJob } from "./push-delivery";
import { RemoteAccountId } from "./remote-account-id";
import { base64UrlToBytes, bytesToBase64Url } from "./vapid";

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

type Subscriber = Readonly<{
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  auth: Uint8Array;
}>;

const newSubscriber = async (): Promise<Subscriber> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  if (!("privateKey" in pair)) {
    throw new Error("expected a key pair");
  }
  const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(exported instanceof ArrayBuffer)) {
    throw new Error("expected raw key bytes");
  }
  return {
    privateKey: pair.privateKey,
    publicRaw: new Uint8Array(exported),
    auth: crypto.getRandomValues(new Uint8Array(16)),
  };
};

const utf8 = new TextEncoder();

const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const derive = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8),
  );
};

const sharedSecret = async (subscriber: Subscriber, senderRaw: Uint8Array) => {
  const sender = await crypto.subtle.importKey(
    "raw",
    senderRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const algorithm = { name: "ECDH", public: sender };
  return new Uint8Array(await crypto.subtle.deriveBits(algorithm, subscriber.privateKey, 256));
};

const open = async (key: Uint8Array, nonce: Uint8Array, data: Uint8Array) => {
  const cek = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cek, data));
};

/** RFC 8291 decryption, written from the RFC rather than from the sender code. */
const decryptAes128gcm = async (subscriber: Subscriber, body: Uint8Array): Promise<string> => {
  const salt = body.slice(0, 16);
  const idLength = body[20] ?? 0;
  const senderRaw = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const ikm = await derive(
    subscriber.auth,
    await sharedSecret(subscriber, senderRaw),
    join(utf8.encode("WebPush: info\0"), subscriber.publicRaw, senderRaw),
    32,
  );
  const cek = await derive(salt, ikm, utf8.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await derive(salt, ikm, utf8.encode("Content-Encoding: nonce\0"), 12);
  const plain = await open(cek, nonce, ciphertext);
  expect(plain[plain.length - 1]).toBe(0x02);
  return new TextDecoder().decode(plain.slice(0, -1));
};

const prefixed = (key: Uint8Array) => join(new Uint8Array([0, key.length]), key);

/** draft-ietf-webpush-encryption-04 (`aesgcm`) decryption. */
const decryptAesgcm = async (
  subscriber: Subscriber,
  body: Uint8Array,
  headers: Headers,
): Promise<string> => {
  const salt = base64UrlToBytes(/salt=([^;,\s]+)/.exec(headers.get("encryption") ?? "")?.[1] ?? "");
  const senderRaw = base64UrlToBytes(
    /dh=([^;,\s]+)/.exec(headers.get("crypto-key") ?? "")?.[1] ?? "",
  );
  const ikm = await derive(
    subscriber.auth,
    await sharedSecret(subscriber, senderRaw),
    utf8.encode("Content-Encoding: auth\0"),
    32,
  );
  const context = join(utf8.encode("P-256\0"), prefixed(subscriber.publicRaw), prefixed(senderRaw));
  const cek = await derive(salt, ikm, join(utf8.encode("Content-Encoding: aesgcm\0"), context), 16);
  const nonce = await derive(
    salt,
    ikm,
    join(utf8.encode("Content-Encoding: nonce\0"), context),
    12,
  );
  const plain = await open(cek, nonce, body);
  const padding = ((plain[0] ?? 0) << 8) | (plain[1] ?? 0);
  return new TextDecoder().decode(plain.slice(2 + padding));
};

type Captured = Readonly<{ url: string; headers: Headers; body: Uint8Array }>;

/** Answer POSTs to `host` with `status`, recording them; other fetches pass through. */
const withPushService = async (
  host: string,
  status: number,
  run: (captured: Captured[]) => Promise<void>,
): Promise<void> => {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === host) {
      captured.push({
        url: request.url,
        headers: request.headers,
        body: new Uint8Array(await request.arrayBuffer()),
      });
      return new Response(null, { status });
    }
    return original(input, init);
  };
  try {
    await run(captured);
  } finally {
    globalThis.fetch = original;
  }
};

const SubscriptionSchema = z.object({ id: z.number().int() });

const subscribe = async (
  email: string,
  endpoint: string,
  subscriber: Subscriber,
  data: Record<string, unknown>,
  standard: boolean,
): Promise<number> => {
  const response = await json("/api/v1/push/subscription", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({
      subscription: {
        endpoint,
        keys: {
          p256dh: bytesToBase64Url(subscriber.publicRaw),
          auth: bytesToBase64Url(subscriber.auth),
        },
        standard,
      },
      data,
    }),
  });
  expect(response.status).toBe(200);
  return read(SubscriptionSchema, response.body).id;
};

const accountId = async (email: string): Promise<string> =>
  read(
    z.object({ id: z.string() }),
    (await json("/api/v1/accounts/verify_credentials", { headers: await authHeaders(email) })).body,
  ).id;

/** `fan` favourites a fresh post by `author`; answers the author's notification id. */
const favouriteNotification = async (author: string, fan: string): Promise<string> => {
  const posted = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(author)) },
    body: JSON.stringify({ status: "push me <b>please</b>" }),
  });
  const statusId = read(z.object({ id: z.string() }), posted.body).id;
  const faved = await json(`/api/v1/statuses/${statusId}/favourite`, {
    method: "POST",
    headers: await authHeaders(fan),
  });
  expect(faved.status).toBe(200);
  const listed = await json("/api/v1/notifications?types[]=favourite", {
    headers: await authHeaders(author),
  });
  const notification = read(
    z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        status: z.object({ id: z.string() }).nullable(),
      }),
    ),
    listed.body,
  ).find((entry) => entry.type === "favourite" && entry.status?.id === statusId);
  if (!notification) {
    throw new Error("favourite notification missing");
  }
  return notification.id;
};

const PayloadSchema = z.object({
  notification_id: z.string(),
  notification_type: z.string(),
  title: z.string(),
  body: z.string(),
  icon: z.string().nullable(),
  preferred_locale: z.string(),
});

describe("push delivery", () => {
  for (const standard of [true, false]) {
    it(`encrypts a notification the subscriber can decrypt (${standard ? "aes128gcm" : "aesgcm"})`, async () => {
      const author = `push-author-${standard ? "std" : "legacy"}@example.com`;
      const fan = `push-fan-${standard ? "std" : "legacy"}@example.com`;
      const host = `push-${standard ? "std" : "legacy"}.example`;
      const subscriber = await newSubscriber();
      const subscriptionId = await subscribe(
        author,
        `https://${host}/send/abc`,
        subscriber,
        { alerts: { favourite: true } },
        standard,
      );
      await withPushService(host, 201, async (captured) => {
        const notificationId = await favouriteNotification(author, fan);
        expect(
          await processPushJob(env, {
            kind: "DeliverPush",
            accountId: await accountId(author),
            notificationId,
            subscriptionId,
          }),
        ).toBe("ok");
        const push = captured.at(-1);
        if (!push) {
          throw new Error("no push was sent");
        }
        expect(push.url).toBe(`https://${host}/send/abc`);
        expect(push.headers.get("ttl")).toBe(String(48 * 60 * 60));
        const text = standard
          ? await decryptAes128gcm(subscriber, push.body)
          : await decryptAesgcm(subscriber, push.body, push.headers);
        const payload = read(PayloadSchema, JSON.parse(text));
        expect(payload.notification_id).toBe(notificationId);
        expect(payload.notification_type).toBe("favourite");
        expect(payload.title).toContain("favorited your post");
        // The post text is plain: its markup characters survive, entities decoded.
        expect(payload.body).toBe("push me <b>please</b>");

        // The VAPID token is signed by the advertised key for the push service's origin.
        const authorization = push.headers.get("authorization") ?? "";
        const token = standard
          ? /t=([^,\s]+)/.exec(authorization)?.[1]
          : /^WebPush (\S+)$/.exec(authorization)?.[1];
        const advertised = standard
          ? /k=([^,\s]+)/.exec(authorization)?.[1]
          : /p256ecdsa=([^;,\s]+)/.exec(push.headers.get("crypto-key") ?? "")?.[1];
        expect(push.headers.get("content-encoding")).toBe(standard ? "aes128gcm" : "aesgcm");
        const point = base64UrlToBytes(advertised ?? "");
        const publicKey = await importJWK(
          {
            kty: "EC",
            crv: "P-256",
            x: bytesToBase64Url(point.slice(1, 33)),
            y: bytesToBase64Url(point.slice(33)),
          },
          "ES256",
        );
        const verified = await jwtVerify(token ?? "", publicKey, { audience: `https://${host}` });
        expect(verified.payload.sub).toBe("mailto:admin@example.com");
      });
    });
  }

  it("respects alerts and the follow policy, and drops gone subscriptions", async () => {
    const author = "push-policy-author@example.com";
    const fan = "push-policy-fan@example.com";
    const host = "push-policy.example";
    const recipientId = await accountId(author);
    const offId = await subscribe(
      author,
      `https://${host}/off`,
      await newSubscriber(),
      { alerts: { mention: true } },
      true,
    );
    const followedId = await subscribe(
      author,
      `https://${host}/followed`,
      await newSubscriber(),
      { alerts: { favourite: true }, policy: "followed" },
      true,
    );
    const goneId = await subscribe(
      author,
      `https://${host}/gone`,
      await newSubscriber(),
      { alerts: { favourite: true } },
      true,
    );
    const job = (notificationId: string, subscriptionId: number) =>
      processPushJob(env, {
        kind: "DeliverPush",
        accountId: recipientId,
        notificationId,
        subscriptionId,
      });

    await withPushService(host, 410, async (captured) => {
      const notificationId = await favouriteNotification(author, fan);
      const before = captured.length;
      // Favourite alerts are off on this one, and the author does not follow the fan.
      expect(await job(notificationId, offId)).toBe("ok");
      expect(await job(notificationId, followedId)).toBe("ok");
      expect(captured.filter((push) => !push.url.endsWith("/gone"))).toHaveLength(0);
      expect(captured.length).toBe(before);

      // A 410 from the push service removes the subscription.
      expect(await job(notificationId, goneId)).toBe("ok");
      const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE id = ?")
        .bind(goneId)
        .first<{ n: number }>();
      expect(rows?.n).toBe(0);
    });

    // Once the author follows the fan, the `followed` policy lets it through.
    const follow = await json(`/api/v1/accounts/${await accountId(fan)}/follow`, {
      method: "POST",
      headers: await authHeaders(author),
    });
    expect(follow.status).toBe(200);
    await withPushService(host, 503, async (captured) => {
      const notificationId = await favouriteNotification(author, fan);
      expect(await job(notificationId, followedId)).toBe("retry");
      expect(captured.some((push) => push.url.endsWith("/followed"))).toBe(true);
    });
  });

  it("lets a remote follower through the follower policy", async () => {
    const author = "push-remote-follower@example.com";
    const host = "push-remote.example";
    const recipientId = await accountId(author);
    const subscriptionId = await subscribe(
      author,
      `https://${host}/follower`,
      await newSubscriber(),
      { alerts: { favourite: true }, policy: "follower" },
      true,
    );
    const actorUri = "https://remote.example/users/push-fan";
    await env.DB.prepare(
      `INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, display_name, fetched_at)
       VALUES (?, 'push-fan', 'remote.example', ?, ?, 'pem', 'Push Fan', '2026-10-01T00:00:00.000Z')`,
    )
      .bind(actorUri, `${actorUri}/inbox`, `${actorUri}#main-key`)
      .run();
    const status = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(author)) },
      body: JSON.stringify({ status: "for my remote fans" }),
    });
    const statusId = read(z.object({ id: z.string() }), status.body).id;
    const notify = async (id: string) => {
      await env.DB.prepare(
        `INSERT INTO notifications (id, account_id, from_account_id, from_actor_uri, kind, status_id, created_at)
         VALUES (?, ?, ?, ?, 'favourite', ?, '2026-10-21T00:00:00.000Z')`,
      )
        .bind(id, recipientId, RemoteAccountId.encode(actorUri), actorUri, statusId)
        .run();
      return processPushJob(env, {
        kind: "DeliverPush",
        accountId: recipientId,
        notificationId: id,
        subscriptionId,
      });
    };
    await withPushService(host, 201, async (captured) => {
      // Not a follower yet: nothing is sent.
      expect(await notify("push-remote-1")).toBe("ok");
      expect(captured).toHaveLength(0);
      await env.DB.prepare(
        `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at)
         VALUES ('push-remote-follow', ?, ?, 'Fulfilled', 'Accepted', '2026-10-21T00:00:00.000Z')`,
      )
        .bind(actorUri, recipientId)
        .run();
      expect(await notify("push-remote-2")).toBe("ok");
      expect(captured.map((push) => push.url)).toEqual([`https://${host}/follower`]);
    });
  });
});
