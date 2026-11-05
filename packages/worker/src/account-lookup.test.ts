import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { authHeaders } from "../test/auth-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";
import { nowIso } from "./clock";
import { generateAccountKeys } from "./keys";
import { upsertRemoteActor } from "./remote-actor-store";

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

const LookupSchema = MastodonAccountPreviewSchema.extend({ acct: z.string(), url: z.string() });

const lookup = (acct: string): Promise<{ status: number; body: unknown }> =>
  json(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`);

const cacheActor = async (username: string, domain: string): Promise<RemoteActor> => {
  const actorUri = `https://${domain}/users/${username}`;
  const keys = await generateAccountKeys();
  const fetchedAt = IsoInstant.parse(nowIso());
  if (fetchedAt.isErr()) {
    throw new Error("clock");
  }
  const actor = RemoteActor.fromFetched({
    actorUri,
    username,
    domain,
    inboxUri: `${actorUri}/inbox`,
    publicKeyId: `${actorUri}#main-key`,
    publicKeyPem: keys.publicKeyPem,
    displayName: username,
    fetchedAt: fetchedAt.value,
  });
  if (actor.isErr()) {
    throw new Error("actor fixture rejected");
  }
  expect((await upsertRemoteActor(env.DB, actor.value)).isOk()).toBe(true);
  return actor.value;
};

const admin = () => authHeaders("lookup-admin@example.com", { admin: true });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("account lookup", () => {
  it("finds a local account by username, @username, or username@this-domain", async () => {
    const me = await json("/api/v1/accounts/verify_credentials", {
      headers: await authHeaders("lookup-local@example.com"),
    });
    const account = read(LookupSchema, me.body);
    for (const acct of [
      account.username,
      `@${account.username}`,
      `${account.username}@example.com`,
    ]) {
      const found = await lookup(acct);
      expect(found.status).toBe(200);
      expect(read(LookupSchema, found.body).id).toBe(account.id);
    }
  });

  it("finds a cached remote actor by user@domain, port included", async () => {
    await cacheActor("ada", "remote.example");
    await cacheActor("bob", "remote.example:8443");

    const ada = await lookup("@Ada@Remote.Example");
    expect(ada.status).toBe(200);
    const document = read(LookupSchema, ada.body);
    expect(document.acct).toBe("ada@remote.example");
    expect(document.url).toBe("https://remote.example/users/ada");

    const bob = await lookup("bob@remote.example:8443");
    expect(bob.status).toBe(200);
    expect(read(LookupSchema, bob.body).acct).toBe("bob@remote.example:8443");
  });

  it("answers 404 for an uncached remote handle without a WebFinger fetch", async () => {
    const fetched: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      fetched.push(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      return new Response("unexpected", { status: 500 });
    };
    expect((await lookup("nobody@uncached.example")).status).toBe(404);
    expect(fetched).toEqual([]);
  });

  it("answers 404 for a cached actor on a suspended domain", async () => {
    await cacheActor("eve", "suspended-lookup.example");
    expect((await lookup("eve@suspended-lookup.example")).status).toBe(200);
    const blocked = await json("/api/v1/admin/domain_blocks", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await admin()) },
      body: JSON.stringify({ domain: "suspended-lookup.example", severity: "suspend" }),
    });
    expect(blocked.status).toBe(200);
    expect((await lookup("eve@suspended-lookup.example")).status).toBe(404);
  });

  it("answers 404 for a cached actor outside the allow list", async () => {
    await cacheActor("sam", "stranger.example");
    await cacheActor("fay", "friend.example");
    const allowed = await json("/api/v1/admin/domain_allows", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await admin()) },
      body: JSON.stringify({ domain: "friend.example" }),
    });
    expect(allowed.status).toBe(200);
    const { id } = read(z.object({ id: z.string() }), allowed.body);
    try {
      expect((await lookup("sam@stranger.example")).status).toBe(404);
      expect((await lookup("fay@friend.example")).status).toBe(200);
    } finally {
      await json(`/api/v1/admin/domain_allows/${id}`, { method: "DELETE", headers: await admin() });
    }
  });
});
