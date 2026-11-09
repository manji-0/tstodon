import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import type { InstanceIdentity } from "@tstodon/domain";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import {
  ACTIVITY_JSON_ACCEPT,
  fetchActivityJson,
  fetchWebfinger,
  unsignedFetch,
  type FederatedFetchOptions,
} from "./federated-fetch";
import { parseSignatureHeader, verifySignedFetch } from "./http-signature";
import { instanceActorFetchSigner, instanceActorKeyId, instanceActorKeys } from "./instance-actor";
import { firstCollectionPage } from "./remote-collection";
import { resolveRemoteActor, resolveRemoteActorByHandle } from "./remote-actor-fetch";
import { findRemoteActorByUri } from "./remote-actor-store";
import { fetchStamp } from "./remote-quote-verify";
import { persistRemoteObject } from "./remote-status-persist";
import { parseInstanceIdentity } from "./runtime-config";

const HOST = "secure.example";
const ORIGIN = `https://${HOST}`;

const identity = (): InstanceIdentity => parseInstanceIdentity(env)._unsafeUnwrap();

const signed = (): FederatedFetchOptions => ({
  fetchSigner: instanceActorFetchSigner(env.DB, identity()),
});

const instancePublicKey = async (): Promise<string> =>
  (await instanceActorKeys(env.DB))._unsafeUnwrap().publicKeyPem;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/activity+json" } });

/** One GET the mock remote received, and whether its signature verified. */
type Seen = Readonly<{
  url: string;
  signature: string | null;
  date: string | null;
  accept: string | null;
  verified: boolean;
}>;

/**
 * Whether `request` carries a draft-cavage signature by this instance's
 * instance actor over `(request-target) host date accept`, with a fresh
 * `Date`, checked with the server's own verifier and the stored public key.
 */
const signedByInstanceActor = async (request: Request): Promise<boolean> => {
  const parsed = parseSignatureHeader(request.headers.get("Signature") ?? "");
  const date = Date.parse(request.headers.get("Date") ?? "");
  return (
    parsed !== undefined &&
    parsed.keyId === instanceActorKeyId(identity()) &&
    parsed.algorithm === "rsa-sha256" &&
    ["(request-target)", "host", "date", "accept"].every((name) => parsed.headers.includes(name)) &&
    Math.abs(Date.now() - date) < 60_000 &&
    (await verifySignedFetch(request, parsed, await instancePublicKey()))
  );
};

/**
 * A remote server in secure mode (Mastodon's `AUTHORIZED_FETCH`): every GET
 * of an ActivityPub document needs this instance's signature, or it answers
 * 401. WebFinger stays open. `documents` maps a URL to its body, or to a
 * redirect.
 */
const serveSecureRemote = (
  documents: Readonly<Record<string, unknown>>,
  webfinger?: Readonly<{ subject: string; self: string }>,
): Seen[] => {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.host !== HOST) {
      return new Response(null, { status: 404 });
    }
    const verified = await signedByInstanceActor(request);
    seen.push({
      url: url.href,
      signature: request.headers.get("Signature"),
      date: request.headers.get("Date"),
      accept: request.headers.get("Accept"),
      verified,
    });
    if (url.pathname === "/.well-known/webfinger") {
      return webfinger === undefined
        ? new Response(null, { status: 404 })
        : json({
            subject: webfinger.subject,
            links: [{ rel: "self", type: "application/activity+json", href: webfinger.self }],
          });
    }
    if (!verified) {
      return new Response("Request not signed", { status: 401 });
    }
    const document = documents[url.href];
    if (document === undefined) {
      return new Response(null, { status: 404 });
    }
    const redirect = schemaResult(z.object({ redirect: z.string() }))(document);
    return redirect.isOk()
      ? new Response(null, { status: 302, headers: { Location: redirect.value.redirect } })
      : json(document);
  });
  return seen;
};

const actorDocument = (remote: Remote, username: string) => ({
  "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
  id: remote.actorUri,
  type: "Person",
  preferredUsername: username,
  inbox: `${remote.actorUri}/inbox`,
  outbox: `${remote.actorUri}/outbox`,
  publicKey: {
    id: `${remote.actorUri}#main-key`,
    owner: remote.actorUri,
    publicKeyPem: remote.publicKeyPem,
  },
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signed ActivityPub GETs", () => {
  it("signs a fetch as the instance actor, over (request-target) host date accept", async () => {
    const uri = `${ORIGIN}/objects/plain?page=1`;
    const seen = serveSecureRemote({ [uri]: { id: uri, type: "Note" } });

    const fetched = await fetchActivityJson(identity(), uri, signed());

    expect(fetched.isOk()).toBe(true);
    expect(seen).toEqual([expect.objectContaining({ url: uri, verified: true })]);
    const sent = seen[0];
    const parsed = parseSignatureHeader(sent?.signature ?? "");
    expect(parsed?.keyId).toBe(`${identity().publicOrigin.replace(/\/$/, "")}/actor#main-key`);
    expect(parsed?.headers).toEqual(["(request-target)", "host", "date", "accept"]);
    expect(sent?.accept).toBe(ACTIVITY_JSON_ACCEPT);
    expect(new Date(sent?.date ?? "").toUTCString()).toBe(sent?.date);
  });

  it("is refused by a secure-mode server when unsigned", async () => {
    const uri = `${ORIGIN}/objects/unsigned`;
    const seen = serveSecureRemote({ [uri]: { id: uri, type: "Note" } });

    const fetched = await fetchActivityJson(identity(), uri, { fetchSigner: unsignedFetch });

    expect(fetched.isErr()).toBe(true);
    expect(seen).toEqual([expect.objectContaining({ url: uri, signature: null, verified: false })]);
  });

  it("fetches an actor from a secure-mode server, with WebFinger unsigned", async () => {
    const remote = await remoteActor("secure-alice", HOST, { cache: false });
    const seen = serveSecureRemote(
      { [remote.actorUri]: actorDocument(remote, "secure-alice") },
      { subject: `acct:secure-alice@${HOST}`, self: remote.actorUri },
    );

    const actor = await resolveRemoteActorByHandle(
      env.DB,
      identity(),
      `secure-alice@${HOST}`,
      signed(),
    );

    expect(actor.isOk() && actor.value.actorUri).toBe(remote.actorUri);
    const webfinger = seen.filter((entry) => entry.url.includes("/.well-known/webfinger"));
    expect(webfinger.length).toBeGreaterThan(0);
    expect(webfinger.every((entry) => entry.signature === null)).toBe(true);
    const documents = seen.filter((entry) => !entry.url.includes("/.well-known/webfinger"));
    expect(documents).toEqual([expect.objectContaining({ url: remote.actorUri, verified: true })]);
  });

  it("fetches a key's actor from a secure-mode server", async () => {
    const remote = await remoteActor("secure-key", HOST, { cache: false });
    serveSecureRemote(
      { [remote.actorUri]: actorDocument(remote, "secure-key") },
      { subject: `acct:secure-key@${HOST}`, self: remote.actorUri },
    );

    const actor = await resolveRemoteActor(
      env.DB,
      identity(),
      `${remote.actorUri}#main-key`,
      remote.actorUri,
      signed(),
    );

    expect(actor.isOk() && actor.value.publicKeyPem).toBe(remote.publicKeyPem);
  });

  it("fetches a status, a collection and a quote stamp from a secure-mode server", async () => {
    const remote = await remoteActor("secure-bob", HOST);
    const actor = (await findRemoteActorByUri(env.DB, remote.actorUri))._unsafeUnwrap();
    if (actor === undefined) {
      throw new Error("remote actor fixture not cached");
    }
    const noteUri = `${remote.actorUri}/statuses/secure-1`;
    const outbox = `${remote.actorUri}/outbox`;
    const stampUri = `${remote.actorUri}/quote_authorizations/1`;
    serveSecureRemote({
      [noteUri]: {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: noteUri,
        type: "Note",
        attributedTo: remote.actorUri,
        content: "<p>secure</p>",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        published: new Date().toISOString(),
      },
      [outbox]: {
        id: outbox,
        type: "OrderedCollection",
        first: `${outbox}?page=true`,
      },
      [`${outbox}?page=true`]: {
        id: `${outbox}?page=true`,
        type: "OrderedCollectionPage",
        orderedItems: [noteUri],
      },
      [stampUri]: {
        id: stampUri,
        type: "QuoteAuthorization",
        attributedTo: remote.actorUri,
        interactingObject: "https://example.com/users/someone/statuses/1",
        interactionTarget: noteUri,
      },
    });

    const status = await persistRemoteObject(env, identity(), actor, noteUri, signed());
    const page = await firstCollectionPage(identity(), outbox, signed());
    const stamp = await fetchStamp(identity(), stampUri, signed());

    expect(status.isOk() && status.value?.objectUri).toBe(noteUri);
    expect(page?.items).toEqual([noteUri]);
    expect(stamp.kind).toBe("Fetched");
  });

  it("re-signs each same-origin redirect hop for its own request target", async () => {
    const start = `${ORIGIN}/redirect/start`;
    const middle = `${ORIGIN}/redirect/middle?x=1`;
    const end = `${ORIGIN}/redirect/end`;
    const seen = serveSecureRemote({
      [start]: { redirect: "/redirect/middle?x=1" },
      [middle]: { redirect: end },
      [end]: { id: end, type: "Note" },
    });

    const fetched = await fetchActivityJson(identity(), start, signed());

    expect(fetched.isOk() && fetched.value).toEqual({ id: end, type: "Note" });
    expect(seen.map((entry) => [entry.url, entry.verified])).toEqual([
      [start, true],
      [middle, true],
      [end, true],
    ]);
  });

  it("refuses a redirect to another origin without fetching it", async () => {
    const start = `${ORIGIN}/redirect/away`;
    const seen = serveSecureRemote({ [start]: { redirect: "https://elsewhere.example/note" } });
    const spy = vi.mocked(globalThis.fetch);

    const fetched = await fetchActivityJson(identity(), start, signed());

    expect(fetched.isErr()).toBe(true);
    expect(seen.map((entry) => entry.url)).toEqual([start]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses a downgrade to plain HTTP, a fourth redirect and a loop", async () => {
    const downgrade = `${ORIGIN}/redirect/http`;
    const loop = `${ORIGIN}/redirect/loop`;
    const hops = [0, 1, 2, 3, 4].map((hop) => `${ORIGIN}/redirect/hop${hop}`);
    serveSecureRemote({
      [downgrade]: { redirect: `http://${HOST}/note` },
      [loop]: { redirect: loop },
      ...Object.fromEntries(
        hops.map((hop, index) => [
          hop,
          index === hops.length - 1 ? { id: hop, type: "Note" } : { redirect: hops[index + 1] },
        ]),
      ),
    });

    expect((await fetchActivityJson(identity(), downgrade, signed())).isErr()).toBe(true);
    expect((await fetchActivityJson(identity(), loop, signed())).isErr()).toBe(true);
    expect((await fetchActivityJson(identity(), hops[0] ?? "", signed())).isErr()).toBe(true);
    expect((await fetchActivityJson(identity(), hops[1] ?? "", signed())).isOk()).toBe(true);
  });

  it("leaves WebFinger unsigned", async () => {
    const seen = serveSecureRemote({}, { subject: `acct:carol@${HOST}`, self: `${ORIGIN}/carol` });

    const answer = await fetchWebfinger(identity(), `carol@${HOST}`);

    expect(answer.isOk()).toBe(true);
    expect(seen).toEqual([expect.objectContaining({ signature: null })]);
  });

  it("keeps one instance actor key: /actor serves it unsigned and fetches verify against it", async () => {
    const first = await SELF.fetch("https://example.com/actor", {
      headers: { Accept: "application/activity+json" },
    });
    const second = await SELF.fetch("https://example.com/actor", {
      headers: { Accept: "application/activity+json" },
    });
    const KeySchema = z.object({
      publicKey: z.object({ id: z.string(), publicKeyPem: z.string() }),
    });
    const one = schemaResult(KeySchema)(await first.json())._unsafeUnwrap();
    const two = schemaResult(KeySchema)(await second.json())._unsafeUnwrap();
    expect(first.status).toBe(200);
    expect(two.publicKey).toEqual(one.publicKey);
    expect(one.publicKey.id).toBe(instanceActorKeyId(identity()));
    expect(one.publicKey.publicKeyPem).toBe(await instancePublicKey());

    const uri = `${ORIGIN}/objects/stable`;
    const seen = serveSecureRemote({ [uri]: { id: uri, type: "Note" } });
    // Two signers (two requests) sign with the same stored key.
    await fetchActivityJson(identity(), uri, signed());
    await fetchActivityJson(identity(), uri, signed());
    expect(seen.map((entry) => entry.verified)).toEqual([true, true]);
  });
});
