import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ApiInitialState, ApiWebPushSubscription } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { type Browser, ORIGIN, signUp } from "../test/passkey-browser";
import { bytesToBase64Url, vapidPublicKey } from "./vapid";

/** The page's initial state, parsed with the contract the web UI reads it by. */
const initialState = async (fetcher: Browser) =>
  expectContract(
    ApiInitialState,
    JSON.parse(
      /<script id="initial-state" type="application\/json">([^<]*)<\/script>/.exec(
        await (await fetcher("/home")).text(),
      )?.[1] ?? "null",
    ),
  );

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
  return {
    p256dh: bytesToBase64Url(new Uint8Array(exported)),
    auth: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
};

const send = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** The web UI's request body, as `registerer.ts` builds it from `PushSubscription#toJSON()`. */
const registration = async (endpoint: string, alerts?: Record<string, boolean>) => ({
  subscription: { endpoint, expirationTime: null, keys: await subscriberKeys(), standard: true },
  ...(alerts ? { data: { alerts } } : {}),
});

describe("web UI push subscriptions", () => {
  it("subscribes the session, updates its alerts, and boots with it", async () => {
    const { fetcher } = await signUp("web_push");
    const before = await initialState(fetcher);
    expect(before.push_subscription).toBeNull();
    const web = { Authorization: `Bearer ${before.meta.access_token ?? ""}` };

    const created = await send(
      "POST",
      "/api/web/push_subscriptions",
      web,
      await registration("https://push.example/web/one", { mention: true, favourite: true }),
    );
    expect(created.status).toBe(200);
    const subscription = expectContract(ApiWebPushSubscription, await created.json());
    expect(subscription).toMatchObject({
      endpoint: "https://push.example/web/one",
      standard: true,
      policy: "all",
      server_key: vapidPublicKey(env),
    });
    expect(subscription.alerts).toMatchObject({ mention: true, favourite: true, reblog: false });

    // The page now carries it, so the registerer keeps it rather than subscribing again.
    expect((await initialState(fetcher)).push_subscription).toEqual(subscription);

    const updated = await send("PUT", `/api/web/push_subscriptions/${subscription.id}`, web, {
      data: { alerts: { follow: true }, policy: "followed" },
    });
    expect(updated.status).toBe(200);
    const after = expectContract(ApiWebPushSubscription, await updated.json());
    expect(after.id).toBe(subscription.id);
    expect(after.policy).toBe("followed");
    // Alerts left out turn off, as in Mastodon.
    expect(after.alerts).toMatchObject({ follow: true, mention: false, favourite: false });
    expect((await initialState(fetcher)).push_subscription).toEqual(after);

    // A new registration replaces the session's subscription.
    const again = expectContract(
      ApiWebPushSubscription,
      await (
        await send(
          "POST",
          "/api/web/push_subscriptions",
          web,
          await registration("https://push.example/web/two"),
        )
      ).json(),
    );
    expect(again.id).not.toBe(subscription.id);
    expect((await initialState(fetcher)).push_subscription?.endpoint).toBe(
      "https://push.example/web/two",
    );
    // The old id no longer names the session's subscription.
    expect(
      (
        await send("PUT", `/api/web/push_subscriptions/${subscription.id}`, web, {
          data: { alerts: {} },
        })
      ).status,
    ).toBe(404);
  });

  it("refuses requests without the web app's session token, and invalid subscriptions", async () => {
    const body = await registration("https://push.example/web/refused");
    expect((await send("POST", "/api/web/push_subscriptions", {}, body)).status).toBe(401);
    // Other apps subscribe through /api/v1/push/subscription.
    const app = await authHeaders("web-push-app@example.com");
    expect((await send("POST", "/api/web/push_subscriptions", app, body)).status).toBe(403);
    expect(
      (await send("PUT", "/api/web/push_subscriptions/1", app, { data: { alerts: {} } })).status,
    ).toBe(403);

    const { fetcher } = await signUp("web_push_invalid");
    const web = {
      Authorization: `Bearer ${(await initialState(fetcher)).meta.access_token ?? ""}`,
    };
    const local = await send(
      "POST",
      "/api/web/push_subscriptions",
      web,
      await registration("https://127.0.0.1/push"),
    );
    expect(local.status).toBe(422);
    const badKeys = await send("POST", "/api/web/push_subscriptions", web, {
      subscription: {
        endpoint: "https://push.example/web/keys",
        keys: { p256dh: "AAAA", auth: "BBBB" },
      },
    });
    expect(badKeys.status).toBe(422);
    // Nothing to update before subscribing, and `data` is required.
    expect(
      (await send("PUT", "/api/web/push_subscriptions/1", web, { data: { alerts: {} } })).status,
    ).toBe(404);
    expect((await send("PUT", "/api/web/push_subscriptions/1", web, {})).status).toBe(400);
    expect((await initialState(fetcher)).push_subscription).toBeNull();
  });
});
