import { env, SELF } from "cloudflare:test";
import { OutboxJob } from "@tstodon/domain";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { ApiNotification } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { type HeldQueue, holdQueue } from "../test/queue-hold";
import { type Remote, remoteActor } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { processOutboxJob } from "./outbox-job";

/**
 * FED-20: what was left of collections against Mastodon v4.7.5.
 */

const ORIGIN = "https://example.com";

afterEach(() => {
  vi.restoreAllMocks();
});

const ItemRows = z.array(
  z.object({ uri: z.string().nullable(), actor_uri: z.string().nullable(), state: z.string() }),
);

/** The stored items of the remote collection at `uri`, in order. */
const itemRows = async (uri: string) =>
  parseRows(
    ItemRows.element,
    (
      await env.DB.prepare(
        `SELECT i.uri, i.actor_uri, i.state FROM remote_collection_items i
         JOIN remote_collections c ON c.id = i.collection_id WHERE c.uri = ? ORDER BY i.position`,
      )
        .bind(uri)
        .all()
    ).results,
  );

/** Run the held jobs of `kind` as the queue would, once; jobs they queue stay held. */
const runHeld = async (held: HeldQueue, kind: OutboxJob["kind"]) => {
  const taken = held.bodies.splice(0);
  const outcomes: string[] = [];
  for (const body of taken) {
    const job = OutboxJob.parse(body);
    if (job.isOk() && job.value.kind === kind) {
      outcomes.push(await processOutboxJob(env, job.value));
    } else {
      held.bodies.push(body);
    }
  }
  return outcomes;
};

const heldKinds = (held: HeldQueue) =>
  held.bodies.map((body) => {
    const job = OutboxJob.parse(body);
    return job.isOk() ? job.value.kind : "unparsed";
  });

/**
 * Answer remote fetches with `documents`, and with the status `statuses`
 * names for a URL, while `body` runs; any other URL is a 404.
 */
const serving = async <T>(
  documents: ReadonlyArray<Readonly<{ id: string }>>,
  body: () => Promise<T>,
  statuses: Readonly<Record<string, number>> = {},
): Promise<T> => {
  const byUrl = new Map(documents.map((document) => [document.id, document]));
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const status = statuses[href];
    if (status !== undefined) {
      return new Response("refused", { status });
    }
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

const collectionDocument = (
  curator: Remote,
  uri: string,
  orderedItems: ReadonlyArray<unknown> = [],
  name = "Picks",
) => ({
  id: uri,
  type: "FeaturedCollection",
  totalItems: orderedItems.length,
  name,
  attributedTo: curator.actorUri,
  url: uri,
  sensitive: false,
  discoverable: true,
  orderedItems,
});

/** A curator with a stored collection. */
const curatedCollection = async (name: string) => {
  const host = `${name}.example`;
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
  return { curator, uri, featuredCollections };
};

describe("a remote item's authorization fetch", () => {
  const checked = async (name: string, status: number) => {
    const { curator, uri } = await curatedCollection(name);
    const member = await remoteActor("member", `${name}-member.example`);
    const authorizationUri = `${member.actorUri}/feature_authorizations/1`;
    const held = holdQueue();
    expect(
      await curator.send({
        id: `${uri}#updates/1`,
        type: "Update",
        object: collectionDocument(curator, uri, [
          {
            id: `${uri}/items/1`,
            type: "FeaturedItem",
            featuredObject: member.actorUri,
            featureAuthorization: authorizationUri,
          },
        ]),
      }),
    ).toBe(202);
    expect(
      await serving([], () => runHeld(held, "ProcessFeaturedItem"), {
        [authorizationUri]: status,
      }),
    ).toEqual(["ok"]);
    const kinds = heldKinds(held);
    held.release();
    return { rows: await itemRows(uri), kinds };
  };

  // `response_error_unsalvageable?`: a 401, a 408, a 429 and a 5xx but 501
  // are temporary, so `VerifyFeaturedItemWorker` tries again.
  it.each([401, 408, 429, 503])("is checked again after a %i", async (status) => {
    const { rows, kinds } = await checked(`auth-${status}`, status);
    expect(rows).toEqual([expect.objectContaining({ state: "pending" })]);
    expect(kinds).toEqual(["VerifyFeaturedItem"]);
  });

  it.each([403, 404, 410, 501])("rejects the item after a %i", async (status) => {
    const { rows, kinds } = await checked(`auth-${status}`, status);
    expect(rows).toEqual([expect.objectContaining({ state: "rejected" })]);
    expect(kinds).toEqual([]);
  });
});

const createCollection = async (email: string, body: Record<string, unknown>) =>
  SELF.fetch(`${ORIGIN}/api/v1/collections`, {
    method: "POST",
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    body: JSON.stringify({ name: "Picks", sensitive: false, discoverable: true, ...body }),
  });

describe("a collection's language", () => {
  // `LanguageValidator` reads `SUPPORTED_LOCALES`: ISO 639-1 without `gn`
  // and `sm`, its regional variants and ISO 639-3.
  it.each(["en", "zh-TW", "mn-Mong", "tok", "nan-TW"])("takes %s", async (language) => {
    const response = await createCollection("lang-ok@example.com", { language });
    expect(response.status).toBe(200);
  });

  it.each(["gn", "xx", "zh-tw"])("refuses %s", async (language) => {
    const response = await createCollection("lang-refused@example.com", { language });
    expect(response.status).toBe(422);
  });
});

describe("a collection's page", () => {
  it("is its FeaturedCollection for an ActivityPub client and the web app for a browser", async () => {
    const created = await createCollection("page-owner@example.com", { name: "Shown" });
    expect(created.status).toBe(200);
    const { collection } = z
      .object({ collection: z.object({ id: z.string(), uri: z.string() }) })
      .parse(await created.json());

    const document = await SELF.fetch(`${ORIGIN}/collections/${collection.id}`, {
      headers: { accept: "application/activity+json" },
    });
    expect(document.status).toBe(200);
    expect(document.headers.get("content-type")).toContain("application/activity+json");
    expect(await document.json()).toMatchObject({
      id: collection.uri,
      type: "FeaturedCollection",
      name: "Shown",
    });

    const page = await SELF.fetch(`${ORIGIN}/collections/${collection.id}`, {
      headers: { accept: "text/html" },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");

    const missing = await SELF.fetch(`${ORIGIN}/collections/none`, {
      headers: { accept: "application/activity+json" },
    });
    expect(missing.status).toBe(404);
  });
});

const notificationsOf = async (email: string, type: string) => {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/notifications`, {
    headers: await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return expectContract(z.array(ApiNotification), await response.json()).filter(
    (notification) => notification.type === type,
  );
};

describe("a remote collection's update", () => {
  it("notifies the local accounts it features, once per collection", async () => {
    const { curator, uri, featuredCollections } = await curatedCollection("remote-update");
    const email = "remote-update-member@example.com";
    const member = await signedInAccount(email);
    expect(
      await curator.send({
        id: `${curator.actorUri}/feature_requests/1`,
        type: "FeatureRequest",
        object: `${ORIGIN}/users/${member.username}`,
        instrument: uri,
      }),
    ).toBe(202);
    const update = (n: number, name: string) =>
      curator.send({
        id: `${uri}#updates/${n}`,
        type: "Update",
        // A string item leaves the member's accepted request, which has no uri.
        object: collectionDocument(curator, uri, [`${uri}/items/0`], name),
      });

    const held = holdQueue();
    // The name is the same: nothing significant changed.
    expect(await update(1, "Picks")).toBe(202);
    expect(await notificationsOf(email, "collection_update")).toEqual([]);

    expect(await update(2, "Better picks")).toBe(202);
    expect(await update(3, "Best picks")).toBe(202);
    const updates = await notificationsOf(email, "collection_update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      account: { id: expect.stringMatching(/^r_/) },
      collection: { uri, name: "Best picks", local: false },
    });

    expect(
      await curator.send({
        type: "Remove",
        target: featuredCollections,
        object: uri,
      }),
    ).toBe(202);
    expect(await notificationsOf(email, "collection_update")).toEqual([]);
    held.release();
  });
});
