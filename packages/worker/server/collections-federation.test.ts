import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiCollection } from "@tstodon/api";
import {
  ApActorDocument,
  ApCuratedCollectionDocument,
  ApFeatureAuthorizationDocument,
  ApFeaturedCollections,
  ApFeaturedCollectionsPage,
  ApFeaturedItemDocument,
} from "@tstodon/api/activitypub";
import { ACTIVITY_JSON } from "../test/activity-json";
import { expectContract } from "../test/api-contract";
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
