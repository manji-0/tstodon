import { schemaResult } from "@tstodon/core";
import { createExecutionContext, env, SELF } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  ApActivityDocument,
  ApActorDocument,
  ApFeaturedCollection,
} from "@tstodon/api/activitypub";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { envWith } from "../test/env-fixture";
import { type Remote, remoteActor } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";
import { getUsersByUsernameCollectionsFeatured } from "./routes/activitypub";

/**
 * INT-15, pins over federation: the `featured` collection a local actor
 * serves, the `Add` / `Remove` a pin and an unpin send, and a remote actor's
 * `Add` / `Remove` as Mastodon sends them (without an `id`).
 */

const ORIGIN = "https://example.com";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const api = async (email: string, path: string, body: Record<string, unknown> = {}) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status, path).toBe(200);
  return read(z.object({ id: z.string(), uri: z.string().default("") }), await response.json());
};

const featured = async (username: string) => {
  const response = await SELF.fetch(`${ORIGIN}/users/${username}/collections/featured`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/activity+json");
  return expectContract(ApFeaturedCollection, await response.json());
};

const PayloadRows = z.array(z.object({ kind: z.string(), payload_json: z.string() }));

/** The `Add` and `Remove` activities queued for `accountId`, oldest first. */
const queuedFeatured = async (accountId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT kind, payload_json FROM outbound_activities WHERE account_id = ? AND kind IN ('Add', 'Remove') ORDER BY rowid",
  )
    .bind(accountId)
    .all();
  return read(PayloadRows, results).map((row) =>
    expectContract(ApActivityDocument, JSON.parse(row.payload_json)),
  );
};

describe("a local account's featured collection", () => {
  it("is named by the actor and lists the pinned notes, newest pin first", async () => {
    const email = "featured-author@example.com";
    const account = await signedInAccount(email);
    const actorUri = `${ORIGIN}/users/${account.username}`;
    const first = await api(email, "/api/v1/statuses", { status: "first pin" });
    const second = await api(email, "/api/v1/statuses", {
      status: "second pin",
      visibility: "unlisted",
    });
    await api(email, "/api/v1/statuses", { status: "not pinned" });

    const actor = expectContract(
      ApActorDocument,
      await (await SELF.fetch(`${ORIGIN}/users/${account.username}`)).json(),
    );
    expect(actor.featured).toBe(`${actorUri}/collections/featured`);
    expect(await featured(account.username)).toMatchObject({
      id: actor.featured,
      type: "OrderedCollection",
      totalItems: 0,
      orderedItems: [],
    });

    await api(email, `/api/v1/statuses/${first.id}/pin`);
    await api(email, `/api/v1/statuses/${second.id}/pin`);
    expect(await featured(account.username)).toMatchObject({
      totalItems: 2,
      orderedItems: [second.uri, first.uri],
    });

    await api(email, `/api/v1/statuses/${second.id}/unpin`);
    expect((await featured(account.username)).orderedItems).toEqual([first.uri]);
  });

  it("leaves a followers-only pin out of the collection, and announces neither its pin nor its unpin", async () => {
    const email = "featured-private@example.com";
    const account = await signedInAccount(email);
    const open = await api(email, "/api/v1/statuses", { status: "a public pin" });
    const restricted = await api(email, "/api/v1/statuses", {
      status: "a followers-only pin",
      visibility: "private",
    });

    await api(email, `/api/v1/statuses/${open.id}/pin`);
    await api(email, `/api/v1/statuses/${restricted.id}/pin`);
    expect(await featured(account.username)).toMatchObject({
      totalItems: 1,
      orderedItems: [open.uri],
    });
    await api(email, `/api/v1/statuses/${restricted.id}/unpin`);

    expect((await queuedFeatured(account.id)).map((activity) => activity.object)).toEqual([
      open.uri,
    ]);
  });

  it("answers 404 for an account that does not exist", async () => {
    const response = await SELF.fetch(`${ORIGIN}/users/featured-nobody/collections/featured`);
    expect(response.status).toBe(404);
  });

  it("sends an Add for a pin and a Remove for an unpin, once each", async () => {
    const email = "featured-sender@example.com";
    const account = await signedInAccount(email);
    const actorUri = `${ORIGIN}/users/${account.username}`;
    const note = await api(email, "/api/v1/statuses", { status: "pin me" });

    await api(email, `/api/v1/statuses/${note.id}/pin`);
    await api(email, `/api/v1/statuses/${note.id}/pin`);
    await api(email, `/api/v1/statuses/${note.id}/unpin`);
    await api(email, `/api/v1/statuses/${note.id}/unpin`);

    const sent = await queuedFeatured(account.id);
    expect(sent.map((activity) => activity.type)).toEqual(["Add", "Remove"]);
    for (const activity of sent) {
      expect(activity).toMatchObject({
        actor: actorUri,
        target: `${actorUri}/collections/featured`,
        object: note.uri,
      });
    }
  });
});

describe("the featured collection in secure mode", () => {
  const secure = (request: Request | string) => {
    const routes = new Hono<{ Bindings: Env }>();
    routes.get("/users/:username/collections/featured", getUsersByUsernameCollectionsFeatured);
    return routes.request(
      typeof request === "string" ? new Request(new URL(request, ORIGIN)) : request,
      undefined,
      envWith({ AUTHORIZED_FETCH: "true" }),
      createExecutionContext(),
    );
  };

  it("needs a signature, and shows nothing to a signer the account blocks", async () => {
    const email = "featured-secure@example.com";
    const account = await signedInAccount(email);
    const note = await api(email, "/api/v1/statuses", { status: "pinned in secure mode" });
    await api(email, `/api/v1/statuses/${note.id}/pin`);
    const path = `/users/${account.username}/collections/featured`;

    const unsigned = await secure(path);
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get("cache-control")).toBe("private");

    const reader = await remoteActor("featured-reader", "featured-reader.example");
    const signed = await secure(await reader.signedGet(path));
    expect(signed.status).toBe(200);
    expect(expectContract(ApFeaturedCollection, await signed.json()).orderedItems).toEqual([
      note.uri,
    ]);

    const blocked = await remoteActor("featured-blocked", "featured-blocked.example");
    await api(email, `/api/v1/accounts/${RemoteAccountId.encode(blocked.actorUri)}/block`);
    const refused = await secure(await blocked.signedGet(path));
    expect(refused.status).toBe(200);
    expect(expectContract(ApFeaturedCollection, await refused.json())).toMatchObject({
      totalItems: 0,
      orderedItems: [],
    });
  });
});

const featuredUri = (remote: Remote): string => `${remote.actorUri}/collections/featured`;

const pinningActor = (username: string, host: string): Promise<Remote> =>
  remoteActor(username, host, {
    featuredUri: `https://${host}/users/${username}/collections/featured`,
  });

const remoteNote = (remote: Remote, slug: string, extra: Record<string, unknown> = {}) => ({
  id: `${new URL(remote.actorUri).origin}/notes/${slug}`,
  type: "Note",
  attributedTo: remote.actorUri,
  content: `<p>${slug}</p>`,
  published: "2024-05-01T00:00:00.000Z",
  to: [PUBLIC],
  cc: [`${remote.actorUri}/followers`],
  ...extra,
});

/** Deliver `note` as its author's `Create`, so it is cached. */
const deliver = async (remote: Remote, note: ReturnType<typeof remoteNote>): Promise<void> => {
  expect(
    await remote.send({ id: `${note.id}/activity`, type: "Create", to: note.to, object: note }),
  ).toBe(202);
};

/** An `Add` or `Remove` as Mastodon sends it: no `id`, the note by its URI. */
const collectionActivity = (
  remote: Remote,
  type: "Add" | "Remove",
  object: string,
  target: string = featuredUri(remote),
) => ({ type, target, object });

/**
 * Send at `secondsAgo`: an activity without an id is told apart from an
 * earlier one with the same body by when it was signed.
 */
const sendAt = async (
  remote: Remote,
  activity: Record<string, unknown>,
  secondsAgo: number,
): Promise<number> =>
  (await SELF.fetch(await remote.delivery(activity, new Date(Date.now() - secondsAgo * 1000))))
    .status;

const pinnedUris = async (remote: Remote): Promise<string[]> => {
  const response = await SELF.fetch(
    `${ORIGIN}/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/statuses?pinned=true`,
  );
  expect(response.status).toBe(200);
  return read(z.array(z.object({ uri: z.string() })), await response.json()).map(
    (status) => status.uri,
  );
};

describe("a remote actor's Add and Remove", () => {
  it("pins and unpins a note, the newest pin first, and pins it again", async () => {
    const remote = await pinningActor("pinner", "pins.example");
    const first = remoteNote(remote, "pin-first");
    const second = remoteNote(remote, "pin-second");
    await deliver(remote, first);
    await deliver(remote, second);

    expect(await sendAt(remote, collectionActivity(remote, "Add", first.id), 50)).toBe(202);
    expect(await sendAt(remote, collectionActivity(remote, "Add", second.id), 40)).toBe(202);
    expect(await pinnedUris(remote)).toEqual([second.id, first.id]);

    expect(await sendAt(remote, collectionActivity(remote, "Remove", second.id), 30)).toBe(202);
    expect(await pinnedUris(remote)).toEqual([first.id]);

    expect(await sendAt(remote, collectionActivity(remote, "Add", second.id), 20)).toBe(202);
    expect(await pinnedUris(remote)).toEqual([second.id, first.id]);
  });

  it("answers a redelivery of the same signed request without applying it twice", async () => {
    const remote = await pinningActor("pinner-twice", "pins.example");
    const note = remoteNote(remote, "pin-twice");
    await deliver(remote, note);
    const signedAt = new Date(Date.now() - 10_000);
    const add = collectionActivity(remote, "Add", note.id);

    expect((await SELF.fetch(await remote.delivery(add, signedAt))).status).toBe(202);
    expect(await sendAt(remote, collectionActivity(remote, "Remove", note.id), 5)).toBe(202);
    expect((await SELF.fetch(await remote.delivery(add, signedAt))).status).toBe(202);

    expect(await pinnedUris(remote)).toEqual([]);
  });

  it("fetches a note it does not hold from the note's own address", async () => {
    const remote = await pinningActor("pinner-fetch", "pins.example");
    const note = remoteNote(remote, "pin-fetched");
    const original = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = async (input) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      asked.push(href);
      return href === note.id
        ? new Response(JSON.stringify(note), {
            headers: { "content-type": "application/activity+json" },
          })
        : new Response("not found", { status: 404 });
    };
    try {
      expect(await remote.send(collectionActivity(remote, "Add", note.id))).toBe(202);
    } finally {
      globalThis.fetch = original;
    }

    // Other deliveries of this isolate go through the stub too: only this server's count.
    expect(asked.filter((url) => new URL(url).host === "pins.example")).toEqual([note.id]);
    expect(await pinnedUris(remote)).toEqual([note.id]);
  });

  it("ignores another collection, another actor's note, and a note that is not public", async () => {
    const remote = await pinningActor("pinner-strict", "pins.example");
    const other = await pinningActor("pinner-other", "pins.example");
    const own = remoteNote(remote, "pin-own");
    const foreign = remoteNote(other, "pin-foreign");
    const followersOnly = remoteNote(remote, "pin-private", {
      to: [`${remote.actorUri}/followers`],
      cc: [],
    });
    await deliver(remote, own);
    await deliver(other, foreign);
    await deliver(remote, followersOnly);

    const elsewhere = `${remote.actorUri}/collections/other`;
    expect(await sendAt(remote, collectionActivity(remote, "Add", own.id, elsewhere), 50)).toBe(
      202,
    );
    expect(await sendAt(remote, collectionActivity(remote, "Add", foreign.id), 40)).toBe(202);
    expect(await sendAt(remote, collectionActivity(remote, "Add", followersOnly.id), 30)).toBe(202);
    expect(await pinnedUris(remote)).toEqual([]);

    expect(await sendAt(remote, collectionActivity(remote, "Add", own.id), 20)).toBe(202);
    expect(await sendAt(remote, collectionActivity(remote, "Remove", own.id, elsewhere), 10)).toBe(
      202,
    );
    expect(await pinnedUris(remote)).toEqual([own.id]);
  });
});
