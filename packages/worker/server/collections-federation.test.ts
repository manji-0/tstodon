import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiCollection } from "@tstodon/api";
import { Collection } from "@tstodon/domain";
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
import { type Remote, remoteActor } from "../test/remote-actor-fixture";
import { withFeatureRequestActor } from "./activitypub-wire";
import { outboundAudience } from "./outbox-job";
import { RemoteAccountId } from "./remote-account-id";
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

/** A remote account whose `canFeature` lets anyone feature it. */
const featureableRemote = (username: string) => {
  const host = `${username}.example`;
  const actorUri = `https://${host}/users/${username}`;
  return remoteActor(username, host, {
    featurePolicy: Collection.parseFeaturePolicy({ automaticApproval: [PUBLIC] }, { actorUri }),
  });
};

const ItemBody = z.object({
  collection_item: z.object({ id: z.string(), state: z.string(), account_id: z.string() }),
});

describe("featuring a remote account", () => {
  it("asks its server, and follows the Accept, the Reject and the revoke", async () => {
    const ownerEmail = "fed-coll-asker@example.com";
    const owner = await signedInAccount(ownerEmail);
    const accepting = await featureableRemote("feat-accepts");
    const rejecting = await featureableRemote("feat-rejects");
    const unasked = await remoteActor("feat-nopolicy", "feat-nopolicy.example");
    const collection = await createCollection(ownerEmail, { name: "Remote friends" });

    const refused = await SELF.fetch(`${ORIGIN}/api/v1/collections/${collection.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(ownerEmail)) },
      body: JSON.stringify({ account_id: RemoteAccountId.encode(unasked.actorUri) }),
    });
    expect(refused.status).toBe(403);

    const add = async (remote: Remote) =>
      ItemBody.parse(
        await (
          await call("POST", ownerEmail, `/api/v1/collections/${collection.id}/items`, {
            account_id: RemoteAccountId.encode(remote.actorUri),
          })
        ).json(),
      ).collection_item;
    const acceptedItem = await add(accepting);
    const rejectedItem = await add(rejecting);
    expect(acceptedItem).toMatchObject({
      state: "pending",
      account_id: RemoteAccountId.encode(accepting.actorUri),
    });

    const requests = (await queued(owner.id)).filter(
      (activity) => activity.type === "FeatureRequest",
    );
    expect(requests.map((request) => "object" in request && request.object)).toEqual([
      accepting.actorUri,
      rejecting.actorUri,
    ]);
    const [request, rejectedRequest] = requests;
    expect(request).toMatchObject({ instrument: collection.uri });
    expect(request?.id).toMatch(
      new RegExp(`^${ORIGIN}/users/${owner.username}/feature_requests/[0-9a-f-]{36}$`),
    );

    const approval = `https://feat-accepts.example/users/feat-accepts/feature_authorizations/1`;
    expect(
      await accepting.send({
        id: `${accepting.actorUri}#accepts/1`,
        type: "Accept",
        object: request?.id,
        result: approval,
      }),
    ).toBe(202);
    expect(
      await rejecting.send({
        id: `${rejecting.actorUri}#rejects/1`,
        type: "Reject",
        object: rejectedRequest?.id,
      }),
    ).toBe(202);

    const shown = async () =>
      expectContract(
        z.object({ collection: ApiCollection }),
        await (
          await SELF.fetch(`${ORIGIN}/api/v1/collections/${collection.id}`, {
            headers: await authHeaders(ownerEmail),
          })
        ).json(),
      ).collection.items;
    expect(await shown()).toEqual([
      expect.objectContaining({ id: acceptedItem.id, state: "accepted" }),
    ]);
    const added = (await queued(owner.id)).at(-1);
    expect(added).toMatchObject({
      type: "Add",
      target: collection.uri,
      object: { featuredObject: accepting.actorUri, featureAuthorization: approval },
    });

    expect(
      await accepting.send({ id: `${approval}#delete`, type: "Delete", object: approval }),
    ).toBe(202);
    expect(await shown()).toEqual([]);
    expect((await queued(owner.id)).at(-1)).toMatchObject({
      type: "Remove",
      object: `${ORIGIN}/ap/users/${owner.id}/collection_items/${acceptedItem.id}`,
    });
    expect(rejectedItem.state).toBe("pending");
  });
});

describe("a remote account's collections", () => {
  it("are stored from its Add, Update and Remove, and a FeatureRequest is answered", async () => {
    const host = "curator.example";
    const curatorUri = `https://${host}/users/curator`;
    const featuredCollections = `${curatorUri}/featured_collections`;
    const curator = await remoteActor("curator", host, {
      featuredCollectionsUri: featuredCollections,
    });
    const featuredEmail = "fed-coll-asked@example.com";
    const featured = await signedInAccount(featuredEmail);
    const featuredUri = `${ORIGIN}/users/${featured.username}`;
    const uri = `${curatorUri}/collections/7`;
    const document = (name: string) => ({
      id: uri,
      type: "FeaturedCollection",
      totalItems: 0,
      name,
      attributedTo: curatorUri,
      url: `https://${host}/@curator/collections/7`,
      sensitive: false,
      discoverable: true,
      published: "2026-11-20T00:00:00Z",
      updated: "2026-11-20T00:00:00Z",
      summaryMap: { en: "<p>Curated <script>x</script>people</p>" },
      topic: { type: "Hashtag", name: "#People", href: `https://${host}/tags/people` },
      orderedItems: [],
    });

    expect(
      await curator.send({ type: "Add", target: featuredCollections, object: document("Picks") }),
    ).toBe(202);
    const listed = async () =>
      expectContract(
        z.object({ collections: z.array(ApiCollection) }),
        await (
          await SELF.fetch(
            `${ORIGIN}/api/v1/accounts/${RemoteAccountId.encode(curatorUri)}/collections`,
          )
        ).json(),
      ).collections;
    const [stored] = await listed();
    expect(stored).toMatchObject({
      uri,
      url: `https://${host}/@curator/collections/7`,
      local: false,
      name: "Picks",
      language: "en",
      account_id: RemoteAccountId.encode(curatorUri),
      tag: { name: "people" },
    });
    expect(stored?.description).not.toContain("<script>");

    const requestId = `${curatorUri}/feature_requests/1`;
    expect(
      await curator.send({
        id: requestId,
        type: "FeatureRequest",
        object: featuredUri,
        instrument: uri,
      }),
    ).toBe(202);
    const accepts = (await queued(featured.id)).filter((activity) => activity.type === "Accept");
    expect(accepts).toHaveLength(1);
    const accept = accepts[0];
    expect(accept).toMatchObject({ actor: featuredUri, to: curatorUri, object: requestId });
    const result = accept && "result" in accept ? (accept.result ?? "") : "";
    expect(result).toMatch(
      new RegExp(`^${ORIGIN}/ap/users/${featured.id}/feature_authorizations/`),
    );
    const authorization = await fetchDocument(ApFeatureAuthorizationDocument, result);
    expect(authorization).toMatchObject({ interactingObject: uri, interactionTarget: featuredUri });

    const inCollections = expectContract(
      z.object({ collections: z.array(ApiCollection) }),
      await (
        await SELF.fetch(`${ORIGIN}/api/v1/accounts/${featured.id}/in_collections`, {
          headers: await authHeaders(featuredEmail),
        })
      ).json(),
    ).collections;
    expect(inCollections.map((collection) => collection.uri)).toEqual([uri]);
    expect(inCollections[0]?.items).toEqual([
      expect.objectContaining({ state: "accepted", account_id: featured.id }),
    ]);

    expect(
      await curator.send({ id: `${uri}#updates/1`, type: "Update", object: document("Renamed") }),
    ).toBe(202);
    expect((await listed())[0]?.name).toBe("Renamed");

    expect(await curator.send({ type: "Remove", target: featuredCollections, object: uri })).toBe(
      202,
    );
    expect(await listed()).toEqual([]);
  });

  it("names the signer as a FeatureRequest's actor, as Mastodon sends none", () => {
    expect(
      withFeatureRequestActor(
        { id: "https://r.example/f/1", type: "FeatureRequest" },
        "https://r.example/users/a#main-key",
      ),
    ).toMatchObject({ actor: "https://r.example/users/a" });
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
