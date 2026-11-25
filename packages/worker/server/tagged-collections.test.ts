import { env, SELF } from "cloudflare:test";
import { ApiCollection, ApiCredentialAccount, ApiStatus } from "@tstodon/api";
import { OutboxJob } from "@tstodon/domain";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { type HeldQueue, holdQueue } from "../test/queue-hold";
import { type Remote, remoteActor } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { processOutboxJob } from "./outbox-job";

/**
 * FED-20: a status's `tagged_collections`, as Mastodon v4.7.5's
 * `Status#tagged_objects` holds them: a remote note's `FeaturedCollection`
 * tags and the collections a local post links.
 */

const ORIGIN = "https://example.com";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

afterEach(() => {
  vi.restoreAllMocks();
});

const send = async (
  method: string,
  path: string,
  options: Readonly<{ as?: string; body?: unknown; accept?: string }> = {},
): Promise<Readonly<{ status: number; body: unknown }>> => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(options.as ? await authHeaders(options.as) : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.accept ? { accept: options.accept } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
};

const accountId = async (email: string): Promise<string> =>
  expectContract(
    ApiCredentialAccount,
    (await send("GET", "/api/v1/accounts/verify_credentials", { as: email })).body,
  ).id;

const createCollection = async (owner: string, body: Record<string, unknown> = {}) => {
  const created = await send("POST", "/api/v1/collections", {
    as: owner,
    body: { name: "Picks", sensitive: false, discoverable: true, ...body },
  });
  expect(created.status).toBe(200);
  return expectContract(z.object({ collection: ApiCollection }), created.body).collection;
};

const status = async (id: string, as?: string) => {
  const shown = await send("GET", `/api/v1/statuses/${id}`, as ? { as } : {});
  expect(shown.status).toBe(200);
  return expectContract(ApiStatus, shown.body);
};

const taggedIds = async (id: string, as?: string) =>
  (await status(id, as)).tagged_collections.map((collection) => collection.id);

const remoteStatusId = async (objectUri: string): Promise<string> =>
  parseRows(
    z.object({ id: z.string() }),
    (
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(objectUri)
        .all()
    ).results,
  )[0]?.id ?? "";

const collectionDocument = (curator: Remote, uri: string, name = "Remote picks") => ({
  id: uri,
  type: "FeaturedCollection",
  totalItems: 0,
  name,
  attributedTo: curator.actorUri,
  url: uri,
  sensitive: false,
  discoverable: true,
  orderedItems: [],
});

/** A remote curator with one stored collection. */
const curatedCollection = async (host: string) => {
  const featuredCollections = `https://${host}/users/curator/featured_collections`;
  const curator = await remoteActor("curator", host, {
    featuredCollectionsUri: featuredCollections,
  });
  const uri = `${curator.actorUri}/collections/1`;
  expect(
    await curator.send({
      type: "Add",
      target: featuredCollections,
      object: collectionDocument(curator, uri),
    }),
  ).toBe(202);
  const [row] = parseRows(
    z.object({ id: z.string() }),
    (await env.DB.prepare("SELECT id FROM remote_collections WHERE uri = ?").bind(uri).all())
      .results,
  );
  return { curator, uri, id: row?.id ?? "" };
};

const note = (author: Remote, id: string, tag: ReadonlyArray<unknown>, extra = {}) => ({
  id,
  type: "Note",
  attributedTo: author.actorUri,
  content: "<p>see these</p>",
  published: "2026-11-01T00:00:00.000Z",
  to: [PUBLIC],
  tag,
  ...extra,
});

/** Answer each fetch of a document's `id` with it, anything else with a 404, while `body` runs. */
const serving = async <T>(
  documents: ReadonlyArray<Readonly<{ id: string } & Record<string, unknown>>>,
  body: () => Promise<T>,
): Promise<T> => {
  const byUrl = new Map(documents.map((document) => [document.id, document]));
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const document = byUrl.get(href);
    return document === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(document), {
          headers: { "content-type": "application/activity+json" },
        });
  };
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
};

const heldResolves = (held: HeldQueue) =>
  held.bodies.flatMap((body) => {
    const job = OutboxJob.parse(body);
    return job.isOk() && job.value.kind === "ResolveTaggedCollection" ? [job.value] : [];
  });

describe("a remote note's FeaturedCollection tags", () => {
  it("tags the stored collections a Create names and an Update leaves", async () => {
    const { curator, uri, id: remoteId } = await curatedCollection("tagging-curator.example");
    const local = await createCollection("tagged-owner@example.com");
    const objectUri = `${curator.actorUri}/statuses/tagging-1`;
    expect(
      await curator.send({
        id: `${objectUri}/activity`,
        type: "Create",
        object: note(curator, objectUri, [
          { type: "Hashtag", name: "#picks", href: "https://tagging-curator.example/tags/picks" },
          { type: "FeaturedCollection", id: uri },
          { type: ["FeaturedCollection"], id: local.uri },
        ]),
      }),
    ).toBe(202);
    const id = await remoteStatusId(objectUri);
    const shown = await status(id);
    expect(shown.tagged_collections).toEqual([
      expect.objectContaining({ id: remoteId, uri, local: false, name: "Remote picks" }),
      expect.objectContaining({ id: local.id, uri: local.uri, local: true }),
    ]);

    expect(
      await curator.send({
        id: `${objectUri}#updates/1`,
        type: "Update",
        object: note(curator, objectUri, [{ type: "FeaturedCollection", id: local.uri }], {
          content: "<p>only mine now</p>",
          updated: "2026-11-02T00:00:00.000Z",
        }),
      }),
    ).toBe(202);
    expect(await taggedIds(id)).toEqual([local.id]);
  });

  it("queues a resolve for a collection not stored yet, which tags it once fetched", async () => {
    const curator = await remoteActor("curator", "unstored-curator.example");
    const uri = `${curator.actorUri}/collections/7`;
    const objectUri = `${curator.actorUri}/statuses/unstored-1`;
    const held = holdQueue();
    expect(
      await curator.send({
        id: `${objectUri}/activity`,
        type: "Create",
        object: note(curator, objectUri, [{ type: "FeaturedCollection", id: uri }]),
      }),
    ).toBe(202);
    const id = await remoteStatusId(objectUri);
    const jobs = heldResolves(held);
    held.release();
    expect(jobs).toEqual([
      {
        kind: "ResolveTaggedCollection",
        status: { kind: "RemoteStatus", statusId: id },
        uri,
        lookup: "Uri",
      },
    ]);
    expect(await taggedIds(id)).toEqual([]);

    const outcomes = await serving([collectionDocument(curator, uri, "Fetched picks")], () =>
      Promise.all(jobs.map((job) => processOutboxJob(env, job))),
    );
    expect(outcomes).toEqual(["ok"]);
    expect((await status(id)).tagged_collections).toEqual([
      expect.objectContaining({ uri, name: "Fetched picks", local: false }),
    ]);
  });

  it("does not tag a document that is not the collection it names", async () => {
    const curator = await remoteActor("curator", "forged-curator.example");
    const uri = `${curator.actorUri}/collections/8`;
    const objectUri = `${curator.actorUri}/statuses/forged-1`;
    const held = holdQueue();
    expect(
      await curator.send({
        id: `${objectUri}/activity`,
        type: "Create",
        object: note(curator, objectUri, [{ type: "FeaturedCollection", id: uri }]),
      }),
    ).toBe(202);
    const jobs = heldResolves(held);
    held.release();
    const other = { ...collectionDocument(curator, `${curator.actorUri}/collections/9`), id: uri };
    const outcomes = await serving(
      [{ ...other, id: uri, attributedTo: "https://elsewhere.example/users/x" }],
      () => Promise.all(jobs.map((job) => processOutboxJob(env, job))),
    );
    expect(outcomes).toEqual(["ok"]);
    expect(await taggedIds(await remoteStatusId(objectUri))).toEqual([]);
  });
});

describe("a local post's links to collections", () => {
  it("tags the collection a post links, federates it in the note's tag, and drops it on an edit", async () => {
    const author = "linking-author@example.com";
    const collection = await createCollection("linked-owner@example.com", { name: "Linked" });
    const posted = await send("POST", "/api/v1/statuses", {
      as: author,
      body: { status: `look at ${collection.url} please` },
    });
    expect(posted.status).toBe(200);
    const created = expectContract(ApiStatus, posted.body);
    expect(created.tagged_collections).toEqual([
      expect.objectContaining({ id: collection.id, name: "Linked", local: true }),
    ]);

    const document = await send("GET", new URL(created.uri).pathname, {
      accept: "application/activity+json",
    });
    expect(document.status).toBe(200);
    const object = z
      .object({ "@context": z.array(z.unknown()), tag: z.array(z.unknown()) })
      .parse(document.body);
    expect(object.tag).toContainEqual(
      expect.objectContaining({
        id: collection.uri,
        type: "FeaturedCollection",
        name: "Linked",
        url: collection.url,
      }),
    );
    expect(object["@context"][1]).toMatchObject({
      FeaturedCollection: "https://w3id.org/fep/7aa9#FeaturedCollection",
      discoverable: "toot:discoverable",
    });

    const edited = await send("PUT", `/api/v1/statuses/${created.id}`, {
      as: author,
      body: { status: "never mind" },
    });
    expect(edited.status).toBe(200);
    expect(expectContract(ApiStatus, edited.body).tagged_collections).toEqual([]);
    expect(await taggedIds(created.id)).toEqual([]);
  });

  it("tags a stored remote collection by its URI", async () => {
    const { uri, id } = await curatedCollection("linked-curator.social");
    const posted = await send("POST", "/api/v1/statuses", {
      as: "linking-remote@example.com",
      body: { status: `their picks: ${uri}` },
    });
    expect(expectContract(ApiStatus, posted.body).tagged_collections).toEqual([
      expect.objectContaining({ id, uri }),
    ]);
  });

  it("resolves a link to a known server's collection later, and leaves an unknown server's", async () => {
    const curator = await remoteActor("curator", "known-linked.social");
    const uri = `${curator.actorUri}/collections/3`;
    const held = holdQueue();
    const posted = await send("POST", "/api/v1/statuses", {
      as: "linking-later@example.com",
      body: { status: `${uri} and https://unknown-linked.social/collections/3` },
    });
    const created = expectContract(ApiStatus, posted.body);
    const jobs = heldResolves(held);
    held.release();
    expect(jobs).toEqual([
      {
        kind: "ResolveTaggedCollection",
        status: { kind: "LocalStatus", statusId: created.id },
        uri,
        lookup: "Url",
      },
    ]);
    const outcomes = await serving([collectionDocument(curator, uri, "Later")], () =>
      Promise.all(jobs.map((job) => processOutboxJob(env, job))),
    );
    expect(outcomes).toEqual(["ok"]);
    expect((await status(created.id)).tagged_collections).toEqual([
      expect.objectContaining({ uri, name: "Later" }),
    ]);
  });
});

describe("a tagged collection rendered for the viewer", () => {
  it("shows the items the viewer may see, as Collection#items_for", async () => {
    const featuredId = await accountId("tagged-featured@example.com");
    const collection = await createCollection("tagged-curator-owner@example.com", {
      discoverable: false,
      account_ids: [featuredId],
    });
    const posted = await send("POST", "/api/v1/statuses", {
      as: "tagged-poster@example.com",
      body: { status: `undiscoverable: ${collection.url}` },
    });
    const { id } = expectContract(ApiStatus, posted.body);
    const viewer = "tagged-blocker@example.com";
    expect(
      (await send("POST", `/api/v1/accounts/${featuredId}/block`, { as: viewer })).status,
    ).toBe(200);

    const [forAnyone] = (await status(id)).tagged_collections;
    expect(forAnyone).toMatchObject({ id: collection.id, discoverable: false, item_count: 1 });
    const [forBlocker] = (await status(id, viewer)).tagged_collections;
    expect(forBlocker).toMatchObject({ id: collection.id, item_count: 0, items: [] });
  });

  it("goes with its collection", async () => {
    const owner = "tagged-deleter@example.com";
    const collection = await createCollection(owner);
    const posted = await send("POST", "/api/v1/statuses", {
      as: "tagged-survivor@example.com",
      body: { status: collection.url },
    });
    const { id } = expectContract(ApiStatus, posted.body);
    expect(await taggedIds(id)).toEqual([collection.id]);
    expect(
      (await send("DELETE", `/api/v1/collections/${collection.id}`, { as: owner })).status,
    ).toBe(200);
    expect(await taggedIds(id)).toEqual([]);
  });
});
