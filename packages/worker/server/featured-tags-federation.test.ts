import { schemaResult } from "@tstodon/core";
import { createExecutionContext, env, SELF } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  ApActivityDocument,
  ApActorDocument,
  ApFeaturedTagsCollection,
} from "@tstodon/api/activitypub";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { envWith } from "../test/env-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";
import { getUsersByUsernameCollectionsTags } from "./routes/activitypub";

/**
 * INT-14, featured hashtags from tstodon to other servers: the `featuredTags`
 * collection a local actor serves, and the `Add` / `Remove` that featuring
 * and unfeaturing a hashtag send. A remote actor's featured hashtag is
 * accepted and not kept yet.
 */

const ORIGIN = "https://example.com";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const request = async (email: string, method: string, path: string, body?: unknown) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, `${method} ${path}`).toBe(200);
  return response.json();
};

const featuredTags = async (username: string) => {
  const response = await SELF.fetch(`${ORIGIN}/users/${username}/collections/tags`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/activity+json");
  return expectContract(ApFeaturedTagsCollection, await response.json());
};

const PayloadRows = z.array(z.object({ payload_json: z.string() }));

/** The `Add` and `Remove` activities queued for `accountId`, oldest first. */
const queued = async (accountId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT payload_json FROM outbound_activities WHERE account_id = ? AND kind IN ('Add', 'Remove') ORDER BY rowid",
  )
    .bind(accountId)
    .all();
  return read(PayloadRows, results).map((row) =>
    expectContract(ApActivityDocument, JSON.parse(row.payload_json)),
  );
};

describe("a local account's featured hashtags", () => {
  it("are a collection the actor names, of Hashtag objects", async () => {
    const email = "tags-author@example.com";
    const account = await signedInAccount(email);
    const actorUri = `${ORIGIN}/users/${account.username}`;

    const actor = expectContract(
      ApActorDocument,
      await (await SELF.fetch(`${ORIGIN}/users/${account.username}`)).json(),
    );
    expect(actor.featuredTags).toBe(`${actorUri}/collections/tags`);
    expect(await featuredTags(account.username)).toMatchObject({
      id: actor.featuredTags,
      type: "Collection",
      totalItems: 0,
      items: [],
    });

    await request(email, "POST", "/api/v1/featured_tags", { name: "tstodon" });
    expect(await featuredTags(account.username)).toMatchObject({
      totalItems: 1,
      items: [{ type: "Hashtag", href: "https://example.com/tags/tstodon", name: "#tstodon" }],
    });

    await request(email, "DELETE", "/api/v1/featured_tags/tstodon");
    expect((await featuredTags(account.username)).items).toEqual([]);
  });

  it("send an Add when featured and a Remove when unfeatured, once each, from either API", async () => {
    const email = "tags-sender@example.com";
    const account = await signedInAccount(email);
    const actorUri = `${ORIGIN}/users/${account.username}`;

    await request(email, "POST", "/api/v1/featured_tags", { name: "first" });
    await request(email, "POST", "/api/v1/featured_tags", { name: "first" });
    await request(email, "DELETE", "/api/v1/featured_tags/first");
    await request(email, "POST", "/api/v1/tags/second/feature");
    await request(email, "POST", "/api/v1/tags/second/feature");
    await request(email, "POST", "/api/v1/tags/second/unfeature");
    await request(email, "POST", "/api/v1/tags/second/unfeature");

    const sent = await queued(account.id);
    expect(
      sent.map((activity) => [activity.type, activity.type === "Add" ? activity.object : null]),
    ).toEqual([
      ["Add", { type: "Hashtag", href: "https://example.com/tags/first", name: "#first" }],
      ["Remove", null],
      ["Add", { type: "Hashtag", href: "https://example.com/tags/second", name: "#second" }],
      ["Remove", null],
    ]);
    for (const activity of sent) {
      // Mastodon reads a featured hashtag from an `Add` to the `featured` collection.
      expect(activity).toMatchObject({
        actor: actorUri,
        target: `${actorUri}/collections/featured`,
        object: { type: "Hashtag" },
      });
    }
  });
});

describe("the featured hashtags collection in secure mode", () => {
  const secure = (request: Request | string) => {
    const routes = new Hono<{ Bindings: Env }>();
    routes.get("/users/:username/collections/tags", getUsersByUsernameCollectionsTags);
    return routes.request(
      typeof request === "string" ? new Request(new URL(request, ORIGIN)) : request,
      undefined,
      envWith({ AUTHORIZED_FETCH: "true" }),
      createExecutionContext(),
    );
  };

  it("needs a signature, and shows nothing to a signer the account blocks", async () => {
    const email = "tags-secure@example.com";
    const account = await signedInAccount(email);
    await request(email, "POST", "/api/v1/featured_tags", { name: "secure" });
    const path = `/users/${account.username}/collections/tags`;

    expect((await secure(path)).status).toBe(401);

    const reader = await remoteActor("tags-reader", "tags-reader.example");
    const signed = await secure(await reader.signedGet(path));
    expect(signed.status).toBe(200);
    expect(expectContract(ApFeaturedTagsCollection, await signed.json()).totalItems).toBe(1);

    const blocked = await remoteActor("tags-blocked", "tags-blocked.example");
    await request(
      email,
      "POST",
      `/api/v1/accounts/${RemoteAccountId.encode(blocked.actorUri)}/block`,
    );
    const refused = await secure(await blocked.signedGet(path));
    expect(refused.status).toBe(200);
    expect(expectContract(ApFeaturedTagsCollection, await refused.json()).items).toEqual([]);
  });
});

describe("a remote actor's featured hashtag", () => {
  it("is accepted as Mastodon sends it, without a fetch", async () => {
    const featuredUri = "https://tags.example/users/tagger/collections/featured";
    const remote = await remoteActor("tagger", "tags.example", { featuredUri });
    const hashtag = {
      type: "Hashtag",
      href: "https://tags.example/@tagger/tagged/interop",
      name: "#interop",
    };
    const original = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = async (input) => {
      asked.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response("not found", { status: 404 });
    };
    try {
      expect(await remote.send({ type: "Add", target: featuredUri, object: hashtag })).toBe(202);
      expect(await remote.send({ type: "Remove", target: featuredUri, object: hashtag })).toBe(202);
    } finally {
      globalThis.fetch = original;
    }

    // Other deliveries of this isolate go through the stub too: only this server's count.
    expect(asked.filter((url) => new URL(url).host === "tags.example")).toEqual([]);
    const pins = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM remote_actor_pins WHERE actor_uri = ?",
    )
      .bind(remote.actorUri)
      .first();
    expect(read(z.object({ n: z.number() }), pins).n).toBe(0);
  });
});
