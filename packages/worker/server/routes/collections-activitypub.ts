import type {
  ApCuratedCollectionDocumentJSON,
  ApFeatureAuthorizationDocumentJSON,
  ApFeaturedCollectionsJSON,
  ApFeaturedCollectionsPageJSON,
  ApFeaturedItemDocumentJSON,
} from "@tstodon/api/activitypub";
import { type Collection, InstanceIdentity, type LocalAccount } from "@tstodon/domain";
import type { Context } from "hono";
import { findAccountById, findAccountsByIds } from "../account-store";
import { authorizeObjectFetch } from "../authorized-fetch";
import {
  type ActorUriOf,
  collectionUri,
  curatedCollectionObject,
  featureAuthorizationContext,
  featureAuthorizationUri,
  featuredCollectionContext,
  featuredCollectionsUri,
  featuredItemContext,
  featuredItemObject,
} from "../collection-documents";
import {
  countAccountCollections,
  findCollection,
  findCollectionOfItem,
  pageCollectionsByAge,
} from "../collection-store";
import { jsonRepositoryError } from "../http";
import { findRemoteCollectionOfItem } from "../remote-curated-collection-store";
import { parseInstanceIdentity } from "../runtime-config";
import { blocksFetcher, documentOwner, jsonLd } from "./activitypub";

type AnyContext = Context<{ Bindings: Env }>;

/** `FeaturedCollectionsController::PER_PAGE`. */
const PER_PAGE = 5;

const notFound = (c: AnyContext) => c.json({ kind: "NotFound" }, 404);

type Served = Readonly<{ identity: InstanceIdentity; account: LocalAccount }> | Response;

/**
 * The local account `/ap/users/:id/…` names, as `AccountOwnedConcern` serves
 * it, and Mastodon's `not_found` for a signed fetcher the account blocks.
 */
const servedOwner = async (c: AnyContext, accountId: string): Promise<Served> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const access = await authorizeObjectFetch(c, identity.value);
  if (access.kind === "Denied") {
    return access.response;
  }
  const found = await findAccountById(c.env.DB, accountId);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return notFound(c);
  }
  const owner = await documentOwner(c, access, found.value.username);
  if (owner.kind === "Refused") {
    return owner.response;
  }
  if (access.kind === "Signed") {
    const hidden = await blocksFetcher(c.env.DB, owner.account, access.actor.actorUri);
    if (hidden.isErr()) {
      return jsonRepositoryError(c, hidden.error.message);
    }
    if (hidden.value) {
      return notFound(c);
    }
  }
  return { identity: identity.value, account: owner.account };
};

/** The actor URIs of the local accounts `collections` name. */
const actorUris = async (
  c: AnyContext,
  identity: InstanceIdentity,
  collections: ReadonlyArray<Collection>,
): Promise<ActorUriOf | Response> => {
  const accounts = await findAccountsByIds(
    c.env.DB,
    collections.flatMap((collection) => [
      collection.accountId,
      ...collection.items.map((item) => item.accountId),
    ]),
  );
  if (accounts.isErr()) {
    return jsonRepositoryError(c, accounts.error.message);
  }
  return (accountId) => {
    const account = accounts.value.get(accountId);
    return account && InstanceIdentity.actorUrl(identity, account.username);
  };
};

/**
 * `GET /ap/users/:id/featured_collections`, Mastodon's unordered
 * `CollectionPresenter`: the count and `first`, or with `page` five
 * collections. Kaminari's `next_page` / `prev_page` are `nil` past either
 * end, and Mastodon then links the collection itself, as here.
 */
export const getApUsersByIdFeaturedCollections = async (
  c: Context<{ Bindings: Env }, "/ap/users/:id/featured_collections">,
) => {
  const served = await servedOwner(c, c.req.param("id"));
  if (served instanceof Response) {
    return served;
  }
  const { identity, account } = served;
  const root = featuredCollectionsUri(identity, account.id);
  const pageUrl = (page: number | string): string =>
    `${root}?page=${encodeURIComponent(String(page))}`;
  const total = await countAccountCollections(c.env.DB, account.id);
  if (total.isErr()) {
    return jsonRepositoryError(c, total.error.message);
  }
  const rawPage = c.req.query("page") ?? "";
  if (rawPage === "") {
    const listing: ApFeaturedCollectionsJSON = {
      "@context": featuredCollectionContext,
      id: root,
      type: "Collection",
      totalItems: total.value,
      first: pageUrl(1),
    };
    return c.json(listing, 200, jsonLd);
  }
  const page = Math.max(Number.parseInt(rawPage, 10) || 1, 1);
  const collections = await pageCollectionsByAge(c.env.DB, account.id, {
    offset: (page - 1) * PER_PAGE,
    limit: PER_PAGE,
  });
  if (collections.isErr()) {
    return jsonRepositoryError(c, collections.error.message);
  }
  const uris = await actorUris(c, identity, collections.value);
  if (uris instanceof Response) {
    return uris;
  }
  const document: ApFeaturedCollectionsPageJSON = {
    "@context": featuredCollectionContext,
    id: pageUrl(rawPage),
    type: "CollectionPage",
    totalItems: total.value,
    next: page * PER_PAGE < total.value ? pageUrl(page + 1) : root,
    prev: page > 1 ? pageUrl(page - 1) : root,
    partOf: root,
    items: collections.value.map((collection) =>
      curatedCollectionObject(identity, collection, uris),
    ),
  };
  return c.json(document, 200, jsonLd);
};

/** `GET /ap/users/:id/collections/:collection_id`: one of the account's collections. */
export const getApUsersByIdCollectionsByCollectionId = async (
  c: Context<{ Bindings: Env }, "/ap/users/:id/collections/:collection_id">,
) => {
  const served = await servedOwner(c, c.req.param("id"));
  if (served instanceof Response) {
    return served;
  }
  const found = await findCollection(c.env.DB, c.req.param("collection_id"));
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value || found.value.accountId !== served.account.id) {
    return notFound(c);
  }
  const uris = await actorUris(c, served.identity, [found.value]);
  if (uris instanceof Response) {
    return uris;
  }
  const document: ApCuratedCollectionDocumentJSON = {
    "@context": featuredCollectionContext,
    ...curatedCollectionObject(served.identity, found.value, uris),
  };
  return c.json(document, 200, jsonLd);
};

/** `GET /ap/users/:id/collection_items/:item_id`: an item of one of the account's collections. */
export const getApUsersByIdCollectionItemsByItemId = async (
  c: Context<{ Bindings: Env }, "/ap/users/:id/collection_items/:item_id">,
) => {
  const served = await servedOwner(c, c.req.param("id"));
  if (served instanceof Response) {
    return served;
  }
  const itemId = c.req.param("item_id");
  const found = await findCollectionOfItem(c.env.DB, itemId);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  const collection = found.value;
  const item = collection?.items.find((candidate) => candidate.id === itemId);
  if (!collection || !item || collection.accountId !== served.account.id) {
    return notFound(c);
  }
  const uris = await actorUris(c, served.identity, [collection]);
  if (uris instanceof Response) {
    return uris;
  }
  const featured = featuredItemObject(served.identity, collection, item, uris);
  if (!featured) {
    return notFound(c);
  }
  const document: ApFeaturedItemDocumentJSON = { "@context": featuredItemContext, ...featured };
  return c.json(document, 200, jsonLd);
};

/** `GET /ap/users/:id/feature_authorizations/:item_id`: the account's consent to an accepted item. */
export const getApUsersByIdFeatureAuthorizationsByItemId = async (
  c: Context<{ Bindings: Env }, "/ap/users/:id/feature_authorizations/:item_id">,
) => {
  const served = await servedOwner(c, c.req.param("id"));
  if (served instanceof Response) {
    return served;
  }
  const itemId = c.req.param("item_id");
  // `@account.collection_items`: an item in a local collection, or in a remote one.
  const [local, remote] = await Promise.all([
    findCollectionOfItem(c.env.DB, itemId),
    findRemoteCollectionOfItem(c.env.DB, itemId),
  ]);
  if (local.isErr()) {
    return jsonRepositoryError(c, local.error.message);
  }
  if (remote.isErr()) {
    return jsonRepositoryError(c, remote.error.message);
  }
  const collection = local.value ?? remote.value;
  const item = collection?.items.find((candidate) => candidate.id === itemId);
  if (!collection || !item || item.accountId !== served.account.id || item.state !== "accepted") {
    return notFound(c);
  }
  const document: ApFeatureAuthorizationDocumentJSON = {
    "@context": featureAuthorizationContext,
    id: featureAuthorizationUri(served.identity, item.accountId, item.id),
    type: "FeatureAuthorization",
    interactingObject:
      collection.kind === "LocalCollection"
        ? collectionUri(served.identity, collection)
        : collection.uri,
    interactionTarget: InstanceIdentity.actorUrl(served.identity, served.account.username),
  };
  return c.json(document, 200, jsonLd);
};
