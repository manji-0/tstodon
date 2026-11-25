import { env, SELF } from "cloudflare:test";
import { ApiCollection, ApiNotification } from "@tstodon/api";
import { ApActivityDocument } from "@tstodon/api/activitypub";
import { OutboxJob } from "@tstodon/domain";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { type HeldQueue, holdQueue } from "../test/queue-hold";
import { type Remote, remoteActor } from "../test/remote-actor-fixture";
import { setAccountLocked } from "./account-store";
import { parseRows } from "./d1";
import { processOutboxJob } from "./outbox-job";

/**
 * FED-20 review: a remote collection's items as Mastodon v4.7.5 processes
 * them. A `FeatureRequest` adds an account once; an `Update` queues one job
 * per item (`ProcessFeaturedItemWorker`) and keeps the accepted request it
 * does not list yet; an authorization that cannot be read is checked again
 * later (`VerifyFeaturedItemWorker`); and each `Reject` has its own id.
 */

const ORIGIN = "https://example.com";

afterEach(() => {
  vi.restoreAllMocks();
});

const PayloadRows = z.array(z.object({ payload_json: z.string() }));

/** What `accountId` queued for delivery, oldest first. */
const queued = async (accountId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT payload_json FROM outbound_activities WHERE account_id = ? ORDER BY rowid",
  )
    .bind(accountId)
    .all();
  return expectContract(PayloadRows, results).map((row) =>
    expectContract(ApActivityDocument, JSON.parse(row.payload_json)),
  );
};

const get = async (email: string, path: string): Promise<unknown> => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, { headers: await authHeaders(email) });
  expect(response.status, path).toBe(200);
  return response.json();
};

const inCollections = async (email: string, accountId: string) =>
  expectContract(
    z.object({ collections: z.array(ApiCollection) }),
    await get(email, `/api/v1/accounts/${accountId}/in_collections`),
  ).collections;

const addedNotifications = async (email: string) =>
  expectContract(z.array(ApiNotification), await get(email, "/api/v1/notifications")).filter(
    (notification) => notification.type === "added_to_collection",
  );

const ItemRows = z.array(
  z.object({
    uri: z.string().nullable(),
    account_id: z.string().nullable(),
    actor_uri: z.string().nullable(),
    state: z.string(),
  }),
);

/** The stored items of the remote collection at `uri`, in order. */
const itemRows = async (uri: string) =>
  parseRows(
    ItemRows.element,
    (
      await env.DB.prepare(
        `SELECT i.uri, i.account_id, i.actor_uri, i.state FROM remote_collection_items i
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

/** Answer remote fetches with `documents`, and 503 for each URL in `failing`, while `body` runs. */
const serving = async <T>(
  documents: ReadonlyArray<Readonly<{ id: string }>>,
  body: () => Promise<T>,
  failing: ReadonlyArray<string> = [],
): Promise<T> => {
  const byUrl = new Map(documents.map((document) => [document.id, document]));
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (failing.includes(href)) {
      return new Response("unavailable", { status: 503 });
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
) => ({
  id: uri,
  type: "FeaturedCollection",
  totalItems: orderedItems.length,
  name: "Picks",
  attributedTo: curator.actorUri,
  url: uri,
  sensitive: false,
  discoverable: true,
  orderedItems,
});

/** A curator with a stored collection, and the local account it asks to feature. */
const curatedSetup = async (name: string) => {
  const host = `${name}.example`;
  const featuredCollections = `https://${host}/users/curator/featured_collections`;
  const curator = await remoteActor("curator", host, {
    featuredCollectionsUri: featuredCollections,
  });
  const email = `${name}@example.com`;
  const featured = await signedInAccount(email);
  const uri = `${curator.actorUri}/collections/1`;
  expect(
    await curator.send({
      type: "Add",
      target: featuredCollections,
      object: collectionDocument(curator, uri),
    }),
  ).toBe(202);
  return { curator, email, featured, featuredUri: `${ORIGIN}/users/${featured.username}`, uri };
};

describe("a remote collection's FeatureRequest", () => {
  it("adds a local account once, and leaves a revoked one revoked", async () => {
    const { curator, email, featured, featuredUri, uri } = await curatedSetup("fr-repeat");
    const request = (n: number) =>
      curator.send({
        id: `${curator.actorUri}/feature_requests/${n}`,
        type: "FeatureRequest",
        object: featuredUri,
        instrument: uri,
      });

    expect(await request(1)).toBe(202);
    expect(await request(2)).toBe(202);

    const accepts = () =>
      queued(featured.id).then((all) => all.filter((activity) => activity.type === "Accept"));
    expect(await accepts()).toHaveLength(1);
    expect(await addedNotifications(email)).toHaveLength(1);
    const [collection] = await inCollections(email, featured.id);
    expect(collection?.items).toEqual([
      expect.objectContaining({ state: "accepted", account_id: featured.id }),
    ]);

    const itemId = collection?.items[0]?.id ?? "";
    const revoked = await SELF.fetch(
      `${ORIGIN}/api/v1/collections/${collection?.id}/items/${itemId}/revoke`,
      { method: "POST", headers: await authHeaders(email) },
    );
    expect(revoked.status).toBe(200);
    expect(await request(3)).toBe(202);

    expect(await accepts()).toHaveLength(1);
    expect(await addedNotifications(email)).toHaveLength(1);
    expect(await itemRows(uri)).toEqual([
      { uri: null, account_id: featured.id, actor_uri: null, state: "revoked" },
    ]);
  });

  it("answers each refusal with a Reject of its own id", async () => {
    const { curator, featured, featuredUri, uri } = await curatedSetup("fr-reject");
    expect((await setAccountLocked(env.DB, featured.id, true)).isOk()).toBe(true);
    for (const n of [1, 2]) {
      expect(
        await curator.send({
          id: `${curator.actorUri}/feature_requests/${n}`,
          type: "FeatureRequest",
          object: featuredUri,
          instrument: uri,
        }),
      ).toBe(202);
    }

    const rejects = (await queued(featured.id)).filter((activity) => activity.type === "Reject");
    expect(rejects.map((reject) => reject.object)).toEqual([
      `${curator.actorUri}/feature_requests/1`,
      `${curator.actorUri}/feature_requests/2`,
    ]);
    const ids = rejects.map((reject) => reject.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(new RegExp(`^${featuredUri}#rejects/feature_requests/.+`));
    }
  });
});

describe("a remote collection's items", () => {
  it("are processed by a job each, the authorization checked again when it cannot be read", async () => {
    const { curator, uri } = await curatedSetup("items-queued");
    const member = await remoteActor("member", "items-member.example");
    const authorizationUri = `${member.actorUri}/feature_authorizations/1`;
    const authorization = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: authorizationUri,
      type: "FeatureAuthorization",
      interactingObject: uri,
      interactionTarget: member.actorUri,
    };
    const item = {
      id: `${uri}/items/1`,
      type: "FeaturedItem",
      featuredObject: member.actorUri,
      featureAuthorization: authorizationUri,
    };
    const held = holdQueue();

    expect(
      await curator.send({
        id: `${uri}#updates/1`,
        type: "Update",
        object: collectionDocument(curator, uri, [item]),
      }),
    ).toBe(202);
    expect(await itemRows(uri)).toEqual([]);
    expect(heldKinds(held)).toEqual(["ProcessFeaturedItem"]);

    expect(
      await serving([], () => runHeld(held, "ProcessFeaturedItem"), [authorizationUri]),
    ).toEqual(["ok"]);
    expect(await itemRows(uri)).toEqual([
      { uri: item.id, account_id: null, actor_uri: null, state: "pending" },
    ]);
    expect(heldKinds(held)).toEqual(["VerifyFeaturedItem"]);

    expect(await serving([authorization], () => runHeld(held, "VerifyFeaturedItem"))).toEqual([
      "ok",
    ]);
    expect(await itemRows(uri)).toEqual([
      { uri: item.id, account_id: null, actor_uri: member.actorUri, state: "accepted" },
    ]);
    held.release();
  });

  it("keep a local account's accepted request the collection does not list yet", async () => {
    const { curator, email, featured, featuredUri, uri } = await curatedSetup("items-local");
    expect(
      await curator.send({
        id: `${curator.actorUri}/feature_requests/1`,
        type: "FeatureRequest",
        object: featuredUri,
        instrument: uri,
      }),
    ).toBe(202);
    const accept = (await queued(featured.id)).find((activity) => activity.type === "Accept");
    const approval = accept && "result" in accept ? accept.result : undefined;
    const held = holdQueue();

    // An item the account is not: its accepted request, which has no uri yet,
    // stays, as `where.not(uri: [...])` leaves a NULL uri alone.
    expect(
      await curator.send({
        id: `${uri}#updates/1`,
        type: "Update",
        object: collectionDocument(curator, uri, [`${uri}/items/0`]),
      }),
    ).toBe(202);
    expect((await inCollections(email, featured.id))[0]?.items).toEqual([
      expect.objectContaining({ state: "accepted", account_id: featured.id }),
    ]);

    const other = await signedInAccount("items-local-other@example.com");
    expect(
      await curator.send({
        id: `${uri}#updates/2`,
        type: "Update",
        object: collectionDocument(curator, uri, [
          {
            id: `${uri}/items/1`,
            type: "FeaturedItem",
            featuredObject: featuredUri,
            featureAuthorization: approval,
          },
          {
            id: `${uri}/items/2`,
            type: "FeaturedItem",
            featuredObject: `${ORIGIN}/users/${other.username}`,
            featureAuthorization: `${ORIGIN}/ap/users/${other.id}/feature_authorizations/0`,
          },
        ]),
      }),
    ).toBe(202);
    expect(await serving([], () => runHeld(held, "ProcessFeaturedItem"))).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
    held.release();

    // The accepted request takes the owner's item; the account that never
    // accepted is checked as `VerifyFeaturedItemService` checks it, and this
    // server serves no such authorization.
    expect(await itemRows(uri)).toEqual([
      { uri: `${uri}/items/1`, account_id: featured.id, actor_uri: null, state: "accepted" },
      { uri: `${uri}/items/2`, account_id: null, actor_uri: null, state: "rejected" },
    ]);
  });
});
