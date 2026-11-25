import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiCollection } from "@tstodon/api";
import {
  ApActivityDocument,
  ApActorDocument,
  ApCuratedCollectionDocument,
  ApFeatureAuthorizationDocument,
  ApFeaturedCollections,
  ApFeaturedCollectionsPage,
  ApFeaturedItemDocument,
} from "@tstodon/api/activitypub";
import { ACTIVITY_JSON } from "../test/activity-json";
import { expectContract } from "../test/api-contract";
import { outboundAudience } from "./outbox-job";
import { authHeaders, signedInAccount } from "../test/auth-fixture";

/**
 * FED-20: collections over federation, as Mastodon v4.7.5 serves and sends
 * them (FEP-7aa9).
 */

const ORIGIN = "https://example.com";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const createCollection = async (email: string, body: Record<string, unknown>) => {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/collections`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ sensitive: false, discoverable: true, ...body }),
  });
  expect(response.status).toBe(200);
  return expectContract(z.object({ collection: ApiCollection }), await response.json()).collection;
};

const fetchDocument = async <T>(schema: z.ZodType<T>, url: string): Promise<T> => {
  const response = await SELF.fetch(url, ACTIVITY_JSON);
  expect(response.status, url).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/activity+json");
  return expectContract(schema, await response.json());
};

const PayloadRows = z.array(z.object({ kind: z.string(), payload_json: z.string() }));

/** What `accountId` queued for delivery, oldest first. */
const queued = async (accountId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT kind, payload_json FROM outbound_activities WHERE account_id = ? ORDER BY rowid",
  )
    .bind(accountId)
    .all();
  return expectContract(PayloadRows, results).map((row) =>
    expectContract(ApActivityDocument, JSON.parse(row.payload_json)),
  );
};

const call = async (method: string, email: string, path: string, body?: unknown) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, `${method} ${path}`).toBe(200);
  return response;
};

describe("a local collection's activities", () => {
  it("send Add, Update and Remove as Mastodon's collection services do", async () => {
    const ownerEmail = "fed-coll-sender@example.com";
    const memberEmail = "fed-coll-member@example.com";
    const owner = await signedInAccount(ownerEmail);
    const member = await signedInAccount(memberEmail);
    const other = await signedInAccount("fed-coll-other@example.com");
    const actor = `${ORIGIN}/users/${owner.username}`;
    const featuredCollections = `${ORIGIN}/ap/users/${owner.id}/featured_collections`;

    const collection = await createCollection(ownerEmail, {
      name: "Sent",
      account_ids: [member.id],
    });
    const [added] = await queued(owner.id);
    expect(added).toMatchObject({
      type: "Add",
      actor,
      target: featuredCollections,
      object: { type: "FeaturedCollection", id: collection.uri, totalItems: 1 },
    });
    expect(added).not.toHaveProperty("id");
    expect(added?.signature).toBeUndefined();

    await call("PUT", ownerEmail, `/api/v1/collections/${collection.id}`, { name: "Renamed" });
    await call("PUT", ownerEmail, `/api/v1/collections/${collection.id}`, { name: "Renamed" });
    const updates = (await queued(owner.id)).filter((activity) => activity.type === "Update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      actor,
      to: [PUBLIC],
      object: { type: "FeaturedCollection", name: "Renamed" },
    });
    expect(updates[0]?.id).toMatch(new RegExp(`^${collection.uri}#updates/\\d+$`));

    const item = await call("POST", ownerEmail, `/api/v1/collections/${collection.id}/items`, {
      account_id: other.id,
    });
    const itemId = z
      .object({ collection_item: z.object({ id: z.string() }) })
      .parse(await item.json()).collection_item.id;
    const itemUri = `${ORIGIN}/ap/users/${owner.id}/collection_items/${itemId}`;
    await call("DELETE", ownerEmail, `/api/v1/collections/${collection.id}/items/${itemId}`);
    const memberItem = collection.items[0]?.id ?? "";
    await call(
      "POST",
      memberEmail,
      `/api/v1/collections/${collection.id}/items/${memberItem}/revoke`,
    );
    await call("DELETE", ownerEmail, `/api/v1/collections/${collection.id}`);

    const rest = (await queued(owner.id)).slice(2);
    expect(rest.map((activity) => activity.type)).toEqual(["Add", "Remove", "Delete", "Remove"]);
    expect(rest[0]).toMatchObject({
      target: collection.uri,
      object: {
        type: "FeaturedItem",
        id: itemUri,
        featuredObject: `${ORIGIN}/users/${other.username}`,
      },
    });
    expect(rest[1]).toMatchObject({ target: collection.uri, object: itemUri });
    expect(rest[2]).toMatchObject({
      id: `${ORIGIN}/ap/users/${member.id}/feature_authorizations/${memberItem}#delete`,
      actor: `${ORIGIN}/users/${member.username}`,
      to: [PUBLIC],
      object: { type: "FeatureAuthorization", interactingObject: collection.uri },
      signature: { creator: `${ORIGIN}/users/${member.username}#main-key` },
    });
    expect(rest[3]).toMatchObject({ target: featuredCollections, object: collection.uri });
  });
});

describe("a collection activity's audience", () => {
  it("is the owner's reach beyond its followers, as CollectionReachFinder's", () => {
    const actor = `${ORIGIN}/users/alice`;
    const reach = (activity: Record<string, unknown>) =>
      outboundAudience(JSON.stringify(activity), "example.com").accountReach;
    expect(
      reach({
        type: "Add",
        actor,
        target: `${ORIGIN}/ap/users/1/featured_collections`,
        object: {},
      }),
    ).toBe(true);
    expect(
      reach({ type: "Remove", actor, target: `${ORIGIN}/ap/users/1/collections/2`, object: "x" }),
    ).toBe(true);
    expect(reach({ type: "Update", actor, object: { type: "FeaturedCollection" } })).toBe(true);
    expect(reach({ type: "Delete", actor, object: { type: "FeatureAuthorization" } })).toBe(true);
    expect(
      reach({ type: "Add", actor, target: `${actor}/collections/featured`, object: "x" }),
    ).toBe(false);
  });
});

describe("a local account's collections over ActivityPub", () => {
  it("are named by the actor, with the canFeature policy Mastodon derives", async () => {
    const owner = await signedInAccount("fed-coll-actor@example.com");
    const actor = await fetchDocument(ApActorDocument, `${ORIGIN}/users/${owner.username}`);
    expect(actor.featuredCollections).toBe(`${ORIGIN}/ap/users/${owner.id}/featured_collections`);
    expect(actor.interactionPolicy).toEqual({ canFeature: { automaticApproval: [PUBLIC] } });
  });

  it("serves the collection, its items and their authorizations", async () => {
    const ownerEmail = "fed-coll-owner@example.com";
    const owner = await signedInAccount(ownerEmail);
    const featured = await signedInAccount("fed-coll-featured@example.com");
    const collection = await createCollection(ownerEmail, {
      name: "Good people",
      description: "Follow them",
      language: "en",
      tag_name: "people",
      account_ids: [featured.id],
    });
    const item = collection.items[0];
    expect(item).toBeDefined();

    const listing = await fetchDocument(
      ApFeaturedCollections,
      `${ORIGIN}/ap/users/${owner.id}/featured_collections`,
    );
    expect(listing).toMatchObject({
      type: "Collection",
      totalItems: 1,
      first: `${ORIGIN}/ap/users/${owner.id}/featured_collections?page=1`,
    });
    const page = await fetchDocument(ApFeaturedCollectionsPage, listing.first);
    expect(page.items.map((entry) => entry.id)).toEqual([collection.uri]);

    const document = await fetchDocument(ApCuratedCollectionDocument, collection.uri);
    expect(document).toMatchObject({
      id: collection.uri,
      type: "FeaturedCollection",
      totalItems: 1,
      name: "Good people",
      attributedTo: `${ORIGIN}/users/${owner.username}`,
      url: collection.url,
      summaryMap: { en: "Follow them" },
      topic: { type: "Hashtag", name: "#people", href: `${ORIGIN}/tags/people` },
    });
    const featuredItem = document.orderedItems[0];
    expect(featuredItem).toMatchObject({
      id: `${ORIGIN}/ap/users/${owner.id}/collection_items/${item?.id ?? ""}`,
      type: "FeaturedItem",
      featuredObject: `${ORIGIN}/users/${featured.username}`,
      featureAuthorization: `${ORIGIN}/ap/users/${featured.id}/feature_authorizations/${item?.id ?? ""}`,
    });

    const itemDocument = await fetchDocument(ApFeaturedItemDocument, featuredItem?.id ?? "");
    expect(itemDocument.featuredObject).toBe(`${ORIGIN}/users/${featured.username}`);
    const authorization = await fetchDocument(
      ApFeatureAuthorizationDocument,
      featuredItem?.featureAuthorization ?? "",
    );
    expect(authorization).toMatchObject({
      type: "FeatureAuthorization",
      interactingObject: collection.uri,
      interactionTarget: `${ORIGIN}/users/${featured.username}`,
    });

    const missing = await SELF.fetch(
      `${ORIGIN}/ap/users/${featured.id}/collections/${collection.id}`,
      ACTIVITY_JSON,
    );
    expect(missing.status).toBe(404);
  });
});
