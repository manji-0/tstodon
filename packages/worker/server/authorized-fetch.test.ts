import { schemaResult } from "@tstodon/core";
import { createExecutionContext, env, SELF } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";
import { envWith } from "../test/env-fixture";
import { getWellKnownNodeinfo, getWellKnownWebfinger } from "./routes/discovery";
import { signFetchRequest } from "./http-signature";
import { generateAccountKeys } from "./keys";
import { remoteActor } from "../test/remote-actor-fixture";
import {
  getActor,
  getUsersByUsername,
  getUsersByUsernameFollowers,
  getUsersByUsernameFollowing,
  getUsersByUsernameOutbox,
  getUsersByUsernameQuoteAuthorizationsById,
  getUsersByUsernameStatusesById,
} from "./routes/activitypub";

/**
 * Secure mode (`AUTHORIZED_FETCH`, OPS-11). The ActivityPub routes run in
 * this isolate (a Hono app) with the setting on or off; the test Worker
 * itself runs with it unset.
 */

const ORIGIN = "https://example.com";

const app = (vars: Readonly<Record<string, string>>) => {
  const routes = new Hono<{ Bindings: Env }>();
  routes.get("/actor", getActor);
  // In the Worker these two are answered by `app/middleware/03.well-known.ts`.
  routes.get("/.well-known/webfinger", getWellKnownWebfinger);
  routes.get("/.well-known/nodeinfo", getWellKnownNodeinfo);
  routes.get("/users/:username", getUsersByUsername);
  routes.get("/users/:username/statuses/:id", getUsersByUsernameStatusesById);
  routes.get(
    "/users/:username/quote_authorizations/:id",
    getUsersByUsernameQuoteAuthorizationsById,
  );
  routes.get("/users/:username/outbox", getUsersByUsernameOutbox);
  routes.get("/users/:username/followers", getUsersByUsernameFollowers);
  routes.get("/users/:username/following", getUsersByUsernameFollowing);
  const testEnv = envWith(vars);
  return (request: Request | string) =>
    routes.request(
      typeof request === "string" ? new Request(new URL(request, ORIGIN)) : request,
      undefined,
      testEnv,
      createExecutionContext(),
    );
};

const secure = app({ AUTHORIZED_FETCH: "true" });
const open = app({});

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const USERNAME = "securemode";
const SUSPENDED = "secure-suspended.example";
let notePath = "";

const objectPaths = () => [
  notePath,
  `/users/${USERNAME}/outbox`,
  `/users/${USERNAME}/followers`,
  `/users/${USERNAME}/following`,
  `/users/${USERNAME}/quote_authorizations/none`,
];

beforeAll(async () => {
  const headers = await authHeaders(`${USERNAME}@example.com`);
  const created = await SELF.fetch(`${ORIGIN}/api/v1/statuses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ status: "public, but secure mode", visibility: "public" }),
  });
  expect(created.status).toBe(200);
  notePath = new URL(read(z.object({ uri: z.string() }), await created.json()).uri).pathname;
  await env.DB.prepare(
    "INSERT INTO domain_blocks (id, domain, severity) VALUES ('secure-mode-block', ?, 'suspend')",
  )
    .bind(SUSPENDED)
    .run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("secure mode off (the default)", () => {
  it("serves every object to an unsigned GET, as before", async () => {
    const actor = await open(`/users/${USERNAME}`);
    expect(actor.status).toBe(200);
    expect(read(z.object({ followers: z.string() }), await actor.json()).followers).toBe(
      `${ORIGIN}/users/${USERNAME}/followers`,
    );
    expect(actor.headers.get("cache-control")).toBeNull();
    for (const path of objectPaths().slice(0, 4)) {
      const response = await open(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control"), path).toBeNull();
    }
  });
});

describe("secure mode on (AUTHORIZED_FETCH=true)", () => {
  it("refuses an unsigned GET of a note, the outbox, the collections and a quote stamp with 401", async () => {
    for (const path of objectPaths()) {
      const response = await secure(path);
      expect(response.status, path).toBe(401);
      expect(await response.json(), path).toMatchObject({
        kind: "InvalidSignature",
        error: "Request not signed",
      });
      expect(response.headers.get("vary"), path).toBe("Signature");
      expect(response.headers.get("cache-control"), path).toBe("private");
    }
  });

  it("serves an unsigned GET of an actor the restricted document, with its key", async () => {
    const response = await secure(`/users/${USERNAME}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private");
    expect(response.headers.get("vary")).toBe("Signature");
    const document = read(z.record(z.string(), z.unknown()), await response.json());
    expect(Object.keys(document).sort()).toEqual(
      [
        "@context",
        "endpoints",
        "id",
        "inbox",
        "outbox",
        "preferredUsername",
        "publicKey",
        "type",
      ].sort(),
    );
    expect(document).toMatchObject({
      id: `${ORIGIN}/users/${USERNAME}`,
      type: "Person",
      preferredUsername: USERNAME,
      inbox: `${ORIGIN}/users/${USERNAME}/inbox`,
      publicKey: {
        id: `${ORIGIN}/users/${USERNAME}#main-key`,
        owner: `${ORIGIN}/users/${USERNAME}`,
      },
    });
  });

  it("serves a signed GET from a domain that federates here, privately", async () => {
    const bob = await remoteActor("secure-bob", "secure-allowed.example");
    for (const path of objectPaths().slice(0, 4)) {
      const response = await secure(await bob.signedGet(path));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control"), path).toBe("private");
      expect(response.headers.get("vary"), path).toBe("Signature");
    }
    const actor = await secure(await bob.signedGet(`/users/${USERNAME}`));
    expect(actor.status).toBe(200);
    // The whole document, profile and collections included.
    expect(read(z.object({ followers: z.string() }), await actor.json()).followers).toBe(
      `${ORIGIN}/users/${USERNAME}/followers`,
    );
    // A quote stamp that does not exist is still a 404 to a signed GET.
    expect((await secure(await bob.signedGet(objectPaths()[4] ?? ""))).status).toBe(404);
  });

  it("refuses a signer on a suspended domain with 403, cached or not, without fetching its key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const cached = await remoteActor("secure-cached", SUSPENDED);
    const uncached = await remoteActor("secure-uncached", SUSPENDED, { cache: false });
    for (const signer of [cached, uncached]) {
      for (const path of [notePath, `/users/${USERNAME}`]) {
        const response = await secure(await signer.signedGet(path));
        expect(response.status, `${signer.actorUri} ${path}`).toBe(403);
        expect(await response.json()).toMatchObject({ kind: "Forbidden" });
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a signer outside the allow list, and an admin-suspended signer, with 403", async () => {
    const limited = app({
      AUTHORIZED_FETCH: "true",
      FEDERATION_ALLOW_HOSTS: "secure-only.example",
    });
    const outsider = await remoteActor("secure-outsider", "secure-outside.example");
    expect((await limited(await outsider.signedGet(notePath))).status).toBe(403);

    const mallory = await remoteActor("secure-mallory", "secure-allowed.example");
    await env.DB.prepare(
      "INSERT INTO remote_actor_moderation (actor_uri, moderation) VALUES (?, 'Suspended')",
    )
      .bind(mallory.actorUri)
      .run();
    expect((await secure(await mallory.signedGet(notePath))).status).toBe(403);
  });

  it("refuses a forged signature with 401, and gives an actor GET the restricted document", async () => {
    const host = "secure-forged.example";
    const forger = await remoteActor("secure-forged", host, { cache: false });
    await remoteActor("secure-forged", host);
    const note = await secure(await forger.signedGet(notePath));
    expect(note.status).toBe(401);
    expect(await note.json()).toMatchObject({
      error: "Verification failed for the request's signature",
    });
    const actor = await secure(await forger.signedGet(`/users/${USERNAME}`));
    expect(actor.status).toBe(200);
    expect(Object.keys(read(z.record(z.string(), z.unknown()), await actor.json()))).not.toContain(
      "followers",
    );
  });

  it("refuses a replayed signed GET signed 13 hours ago, or one dated ahead, with 401 (SIG-1)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const bob = await remoteActor("secure-replayed", "secure-allowed.example");
    const hour = 60 * 60 * 1000;
    for (const date of [new Date(Date.now() - 13 * hour), new Date(Date.now() + 2 * hour)]) {
      const note = await secure(await bob.signedGet(notePath, date));
      expect(note.status, date.toUTCString()).toBe(401);
      const actor = await secure(await bob.signedGet(`/users/${USERNAME}`, date));
      expect(actor.status).toBe(200);
      expect(
        Object.keys(read(z.record(z.string(), z.unknown()), await actor.json())),
      ).not.toContain("followers");
    }
    // The same signer, signing now, is served.
    expect((await secure(await bob.signedGet(notePath))).status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a signature by a remote server's instance actor, fetched on first use", async () => {
    // Mastodon signs its fetches as its instance actor (`/actor`, an `Application`).
    const host = "secure-mastodon.example";
    const actorUri = `https://${host}/actor`;
    const keys = await generateAccountKeys();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new Request(input, init).url;
      return url.split("#")[0] === actorUri
        ? Response.json({
            "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
            id: actorUri,
            type: "Application",
            preferredUsername: host,
            inbox: `${actorUri}/inbox`,
            outbox: `https://${host}/actor/outbox`,
            endpoints: { sharedInbox: `https://${host}/inbox` },
            publicKey: {
              id: `${actorUri}#main-key`,
              owner: actorUri,
              publicKeyPem: keys.publicKeyPem,
            },
          })
        : new Response(null, { status: 404 });
    });
    const url = new URL(notePath, ORIGIN);
    const accept = "application/activity+json";
    const signed = await signFetchRequest(url, keys.privateKeyJwk, `${actorUri}#main-key`, accept);
    const response = await secure(
      new Request(url, { headers: { ...signed._unsafeUnwrap(), Host: url.host, Accept: accept } }),
    );
    expect(response.status).toBe(200);
  });

  it("answers 503 when the signer's key server does not answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 502 }));
    const down = await remoteActor("secure-down", "secure-down.example", { cache: false });
    const response = await secure(await down.signedGet(notePath));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("keeps the instance actor, WebFinger and NodeInfo public", async () => {
    const actor = await secure("/actor");
    expect(actor.status).toBe(200);
    expect(read(z.object({ type: z.string() }), await actor.json()).type).toBe("Application");
    const webfinger = await secure(`/.well-known/webfinger?resource=acct:${USERNAME}@example.com`);
    expect(webfinger.status).toBe(200);
    expect((await secure("/.well-known/nodeinfo")).status).toBe(200);
  });
});
