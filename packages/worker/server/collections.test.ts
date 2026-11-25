import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  ApiAccount,
  ApiCollection,
  ApiCollectionAccountItem,
  ApiCredentialAccount,
  ApiNotification,
  ApiNotificationGroupsResult,
  ApiReport,
} from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";

/**
 * REST-1: Mastodon 4.7.5's collections API (`Api::V1::CollectionsController`,
 * `CollectionItemsController`, `InCollectionsController`) for local accounts.
 */

const ORIGIN = "https://example.com";

type Sent = Readonly<{ status: number; body: unknown; headers: Headers }>;

const send = async (
  method: string,
  path: string,
  options: Readonly<{ as?: string; body?: unknown; scopes?: ReadonlyArray<string> }> = {},
): Promise<Sent> => {
  const headers: Record<string, string> = options.as
    ? await authHeaders(options.as, options.scopes ? { scopes: options.scopes } : undefined)
    : {};
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { ...headers, ...(options.body ? { "content-type": "application/json" } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? undefined : JSON.parse(text),
    headers: response.headers,
  };
};

const accountId = async (email: string): Promise<string> => {
  const response = await send("GET", "/api/v1/accounts/verify_credentials", { as: email });
  return expectContract(ApiCredentialAccount, response.body).id;
};

const Wrapped = z.object({ collection: ApiCollection });
const Listed = z.object({ collections: z.array(ApiCollection) });
const WithAccounts = z.object({ collection: ApiCollection, accounts: z.array(ApiAccount) });
const WrappedItem = z.object({ collection_item: ApiCollectionAccountItem });

const create = async (owner: string, body: Record<string, unknown>) => {
  const response = await send("POST", "/api/v1/collections", {
    as: owner,
    body: { sensitive: false, discoverable: true, ...body },
  });
  expect(response.status).toBe(200);
  return expectContract(Wrapped, response.body).collection;
};

describe("collections (REST-1)", () => {
  it("creates a collection that features local accounts, as the owner and others see it", async () => {
    const owner = "coll-owner@example.com";
    const featured = "coll-featured@example.com";
    const ownerId = await accountId(owner);
    const featuredId = await accountId(featured);

    const collection = await create(owner, {
      name: "Friends",
      description: "People I like",
      language: "en",
      tag_name: "Fediverse",
      account_ids: [featuredId],
    });
    expect(collection).toMatchObject({
      name: "Friends",
      description: "People I like",
      language: "en",
      account_id: ownerId,
      local: true,
      sensitive: false,
      discoverable: true,
      item_count: 1,
      uri: `${ORIGIN}/ap/users/${ownerId}/collections/${collection.id}`,
      url: `${ORIGIN}/collections/${collection.id}`,
      tag: { name: "fediverse", url: `https://example.com/tags/fediverse` },
    });
    expect(collection.items).toEqual([
      expect.objectContaining({ state: "accepted", account_id: featuredId }),
    ]);

    const shown = await send("GET", `/api/v1/collections/${collection.id}`);
    expect(shown.status).toBe(200);
    const withAccounts = expectContract(WithAccounts, shown.body);
    expect(withAccounts.accounts.map((account) => account.id)).toEqual([ownerId, featuredId]);

    const notifications = await send("GET", "/api/v1/notifications", { as: featured });
    const added = expectContract(z.array(ApiNotification), notifications.body).find(
      (notification) => notification.type === "added_to_collection",
    );
    expect(added).toMatchObject({
      type: "added_to_collection",
      account: { id: ownerId },
      collection: { id: collection.id, name: "Friends" },
    });

    const grouped = await send("GET", "/api/v2/notifications", { as: featured });
    const groups = expectContract(ApiNotificationGroupsResult, grouped.body);
    expect(groups.notification_groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "added_to_collection",
          collection: expect.objectContaining({ id: collection.id }),
        }),
      ]),
    );
  });

  it("answers Mastodon's validation errors", async () => {
    const owner = "coll-invalid@example.com";
    const response = await send("POST", "/api/v1/collections", {
      as: owner,
      body: { name: "", description: "x".repeat(101) },
    });
    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: {
        error:
          "Validation failed: Name can't be blank, Description is too long (maximum is 100 characters), Sensitive is not included in the list, Discoverable is not included in the list",
        details: {
          name: [{ error: "ERR_BLANK", description: "can't be blank" }],
          description: [
            { error: "ERR_TOO_LONG", description: "is too long (maximum is 100 characters)" },
          ],
          sensitive: [{ error: "ERR_INCLUSION", description: "is not included in the list" }],
          discoverable: [{ error: "ERR_INCLUSION", description: "is not included in the list" }],
        },
      },
    });
  });

  it("lists an account's collections, the undiscoverable ones to the owner only, paged by offset", async () => {
    const owner = "coll-lister@example.com";
    const ownerId = await accountId(owner);
    const shown = await create(owner, { name: "Shown" });
    const hidden = await create(owner, { name: "Hidden", discoverable: false });

    const anonymous = await send("GET", `/api/v1/accounts/${ownerId}/collections`);
    expect(anonymous.status).toBe(200);
    expect(expectContract(Listed, anonymous.body).collections.map((c) => c.id)).toEqual([shown.id]);

    const own = await send("GET", `/api/v1/accounts/${ownerId}/collections`, { as: owner });
    expect(expectContract(Listed, own.body).collections.map((c) => c.id)).toEqual([
      hidden.id,
      shown.id,
    ]);

    const first = await send("GET", `/api/v1/accounts/${ownerId}/collections?limit=1`, {
      as: owner,
    });
    expect(expectContract(Listed, first.body).collections).toHaveLength(1);
    expect(first.headers.get("link")).toBe(
      `<${ORIGIN}/api/v1/accounts/${ownerId}/collections?limit=1&offset=1>; rel="next"`,
    );

    const missing = await send("GET", "/api/v1/accounts/999999999999999999/collections");
    expect(missing.status).toBe(404);
  });

  it("updates a collection and tells the featured accounts once per change", async () => {
    const owner = "coll-updater@example.com";
    const featured = "coll-updated@example.com";
    const featuredId = await accountId(featured);
    const collection = await create(owner, { name: "Before", account_ids: [featuredId] });

    for (const name of ["After", "After again"]) {
      const updated = await send("PUT", `/api/v1/collections/${collection.id}`, {
        as: owner,
        body: { name },
      });
      expect(updated.status).toBe(200);
      expect(expectContract(Wrapped, updated.body).collection.name).toBe(name);
    }

    const notifications = await send("GET", "/api/v1/notifications?types[]=collection_update", {
      as: featured,
    });
    const updates = expectContract(z.array(ApiNotification), notifications.body).filter(
      (notification) => notification.type === "collection_update",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ collection: { name: "After again" } });

    const stranger = await send("PUT", `/api/v1/collections/${collection.id}`, {
      as: "coll-stranger@example.com",
      body: { name: "Mine" },
    });
    expect(stranger.status).toBe(403);
  });

  it("adds, removes and revokes items", async () => {
    const owner = "coll-items@example.com";
    const first = "coll-item-a@example.com";
    const second = "coll-item-b@example.com";
    const firstId = await accountId(first);
    const secondId = await accountId(second);
    const collection = await create(owner, { name: "Items", account_ids: [firstId] });

    const added = await send("POST", `/api/v1/collections/${collection.id}/items`, {
      as: owner,
      body: { account_id: secondId },
    });
    expect(added.status).toBe(200);
    const item = expectContract(WrappedItem, added.body).collection_item;
    expect(item).toMatchObject({ state: "accepted", account_id: secondId });

    const again = await send("POST", `/api/v1/collections/${collection.id}/items`, {
      as: owner,
      body: { account_id: secondId },
    });
    expect(again.status).toBe(422);

    const missing = await send("POST", `/api/v1/collections/${collection.id}/items`, {
      as: owner,
      body: {},
    });
    expect(missing).toMatchObject({
      status: 422,
      body: { error: "`account_id` parameter is missing" },
    });

    const notOwner = await send("POST", `/api/v1/collections/${collection.id}/items`, {
      as: first,
      body: { account_id: secondId },
    });
    expect(notOwner.status).toBe(403);

    const revokedByOwner = await send(
      "POST",
      `/api/v1/collections/${collection.id}/items/${item.id}/revoke`,
      { as: owner },
    );
    expect(revokedByOwner.status).toBe(403);
    const revoked = await send(
      "POST",
      `/api/v1/collections/${collection.id}/items/${item.id}/revoke`,
      { as: second },
    );
    expect(revoked.status).toBe(200);

    const shown = await send("GET", `/api/v1/collections/${collection.id}`);
    expect(
      expectContract(WithAccounts, shown.body).collection.items.map((entry) => entry.account_id),
    ).toEqual([firstId]);

    const firstItem = collection.items[0];
    expect(firstItem).toBeDefined();
    const removed = await send(
      "DELETE",
      `/api/v1/collections/${collection.id}/items/${firstItem?.id ?? ""}`,
      { as: owner },
    );
    expect(removed.status).toBe(200);
    const after = await send("GET", `/api/v1/collections/${collection.id}`, { as: owner });
    expect(expectContract(WithAccounts, after.body).collection.item_count).toBe(0);
  });

  it("refuses to feature a locked account the owner does not follow", async () => {
    const owner = "coll-locked-owner@example.com";
    const locked = "coll-locked@example.com";
    const lockedId = await accountId(locked);
    const lock = await send("PATCH", "/api/v1/accounts/update_credentials", {
      as: locked,
      body: { locked: true },
    });
    expect(lock.status).toBe(200);

    const refused = await send("POST", "/api/v1/collections", {
      as: owner,
      body: { name: "Locked", sensitive: false, discoverable: true, account_ids: [lockedId] },
    });
    expect(refused.status).toBe(403);
  });

  it("hides a collection from an account its owner blocks", async () => {
    const owner = "coll-blocker@example.com";
    const blocked = "coll-blocked@example.com";
    const ownerId = await accountId(owner);
    const blockedId = await accountId(blocked);
    const collection = await create(owner, { name: "Not for you" });
    expect((await send("POST", `/api/v1/accounts/${blockedId}/block`, { as: owner })).status).toBe(
      200,
    );

    expect(
      (await send("GET", `/api/v1/collections/${collection.id}`, { as: blocked })).status,
    ).toBe(403);
    const listed = await send("GET", `/api/v1/accounts/${ownerId}/collections`, { as: blocked });
    expect(listed.status).toBe(200);
    expect(expectContract(Listed, listed.body).collections).toEqual([]);
  });

  it("lists the collections an account is in, to that account only", async () => {
    const owner = "coll-in-owner@example.com";
    const featured = "coll-in-featured@example.com";
    const featuredId = await accountId(featured);
    const collection = await create(owner, { name: "In", account_ids: [featuredId] });

    const own = await send("GET", `/api/v1/accounts/${featuredId}/in_collections`, {
      as: featured,
    });
    expect(own.status).toBe(200);
    expect(expectContract(Listed, own.body).collections.map((c) => c.id)).toEqual([collection.id]);

    const other = await send("GET", `/api/v1/accounts/${featuredId}/in_collections`, { as: owner });
    expect(other.status).toBe(403);
    const anonymous = await send("GET", `/api/v1/accounts/${featuredId}/in_collections`);
    expect(anonymous.status).toBe(422);
  });

  it("deletes a collection", async () => {
    const owner = "coll-deleter@example.com";
    const collection = await create(owner, { name: "Gone" });
    const deleted = await send("DELETE", `/api/v1/collections/${collection.id}`, { as: owner });
    expect(deleted.status).toBe(200);
    expect((await send("GET", `/api/v1/collections/${collection.id}`)).status).toBe(404);
  });

  it("limits each account to its role's collection_limit", async () => {
    const owner = "coll-limit@example.com";
    const me = await send("GET", "/api/v1/accounts/verify_credentials", { as: owner });
    expect(expectContract(ApiCredentialAccount, me.body).role?.collection_limit).toBe(10);
    for (let made = 0; made < 10; made += 1) {
      await create(owner, { name: `Collection ${made}` });
    }
    const over = await send("POST", "/api/v1/collections", {
      as: owner,
      body: { name: "One too many", sensitive: false, discoverable: true },
    });
    expect(over.status).toBe(422);
    expect(over.body).toEqual({
      error: {
        error:
          "Validation failed: Translation missing: en.activerecord.errors.models.collection.attributes.base.too_many",
        details: {
          base: [
            {
              error: "ERR_TOO_MANY",
              description:
                "Translation missing: en.activerecord.errors.models.collection.attributes.base.too_many",
            },
          ],
        },
      },
    });
  });

  it("serves the v1_alpha paths as deprecated, and needs the collections scopes", async () => {
    const owner = "coll-alpha@example.com";
    const collection = await create(owner, { name: "Alpha" });
    const alpha = await send("GET", `/api/v1_alpha/collections/${collection.id}`);
    expect(alpha.status).toBe(200);
    expect(alpha.headers.get("deprecation")).toBe("@1781049600");

    const readOnly = await send("POST", "/api/v1/collections", {
      as: owner,
      scopes: ["read"],
      body: { name: "Nope", sensitive: false, discoverable: true },
    });
    expect(readOnly.status).toBe(403);
    const granular = await send("POST", "/api/v1/collections", {
      as: owner,
      scopes: ["write:collections"],
      body: { name: "Granular", sensitive: false, discoverable: true },
    });
    expect(granular.status).toBe(200);
  });

  it("reports a collection of the reported account, and no other", async () => {
    const owner = "coll-reported@example.com";
    const reporter = "coll-reporter@example.com";
    const ownerId = await accountId(owner);
    const collection = await create(owner, { name: "Reported" });
    const other = await create("coll-not-reported@example.com", { name: "Elsewhere" });

    const refused = await send("POST", "/api/v1/reports", {
      as: reporter,
      body: { account_id: ownerId, collection_ids: [other.id] },
    });
    expect(refused.status).toBe(404);

    const reported = await send("POST", "/api/v1/reports", {
      as: reporter,
      body: { account_id: ownerId, collection_ids: [collection.id] },
    });
    expect(reported.status).toBe(200);
    expect(expectContract(ApiReport, reported.body).collection_ids).toEqual([collection.id]);
  });
});
