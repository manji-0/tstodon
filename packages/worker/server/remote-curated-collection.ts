import { normalizeHashtag } from "@tstodon/core";
import {
  Hostname,
  type InstanceIdentity,
  RemoteCollection,
  type RemoteActor,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountByUsername } from "./account-store";
import { parseLocalActorUsername } from "./activitypub";
import { refId } from "./activitypub-wire";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { newEntityId } from "./ids";
import { resolveRemoteActor } from "./remote-actor-fetch";
import { fetchCollectionPage, firstCollectionPage } from "./remote-collection";
import {
  deleteRemoteItemsExcept,
  findRemoteCollection,
  findRemoteCollectionByUri,
  listRemoteItemRows,
  type RemoteCollectionFields,
  type RemoteItemRow,
  saveRemoteItem,
  upsertRemoteCollection,
} from "./remote-curated-collection-store";

const field = (json: unknown, key: string): unknown =>
  typeof json === "object" && json !== null ? Reflect.get(json, key) : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const sameHost = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  Hostname.ofUri(a) !== undefined &&
  Hostname.ofUri(a) === Hostname.ofUri(b);

/** Ruby's `text[0, limit]`: the first `limit` characters. */
const truncated = (value: string, limit: number): string =>
  Array.from(value).slice(0, limit).join("");

/** `url_to_href(json['url'], 'text/html')`, or the id when there is none usable. */
const htmlUrl = (json: unknown, id: string): string => {
  const raw: unknown = field(json, "url");
  const links: ReadonlyArray<unknown> = Array.isArray(raw) ? raw : [raw];
  const html: unknown = links.find(
    (link) => typeof link === "object" && link !== null && field(link, "mediaType") === "text/html",
  );
  const url =
    refId(html ?? links[0]) ?? (typeof html === "object" ? text(field(html, "href")) : undefined);
  return url !== undefined && /^https?:\/\//i.test(url) ? url : id;
};

/**
 * `ProcessFeaturedCollectionService#collection_attributes`, or none for a
 * document `update!` would refuse (no boolean `sensitive` / `discoverable`).
 */
const collectionFields = (
  actor: RemoteActor,
  json: unknown,
  id: string,
): RemoteCollectionFields | undefined => {
  const sensitive: unknown = field(json, "sensitive");
  const discoverable: unknown = field(json, "discoverable");
  if (typeof sensitive !== "boolean" || typeof discoverable !== "boolean") {
    return undefined;
  }
  const summaryMap: unknown = field(json, "summaryMap");
  const mapEntries =
    typeof summaryMap === "object" && summaryMap !== null ? Object.entries(summaryMap) : [];
  const [firstEntry] = mapEntries;
  const summary = text(firstEntry?.[1]) ?? text(field(json, "summary")) ?? "";
  const totalItems: unknown = field(json, "totalItems");
  const topicName = text(field(field(json, "topic"), "name"));
  const tagName = topicName === undefined ? "" : normalizeHashtag(topicName);
  return {
    actorUri: actor.actorUri,
    uri: id,
    url: htmlUrl(json, id),
    name: truncated(text(field(json, "name")) ?? "", RemoteCollection.nameLimit),
    descriptionHtml: truncated(summary, RemoteCollection.descriptionLimit),
    language: firstEntry?.[0] ?? null,
    sensitive,
    discoverable,
    originalNumberOfItems:
      typeof totalItems === "number" && Number.isInteger(totalItems) && totalItems >= 0
        ? totalItems
        : 0,
    tagName: tagName === "" ? null : tagName,
  };
};

type ItemContext = Readonly<{
  env: Env;
  identity: InstanceIdentity;
  options: FederatedFetchOptions;
  collectionId: string;
  collectionUri: string;
  rows: ReadonlyArray<RemoteItemRow>;
}>;

/**
 * `VerifyFeaturedItemService`: the authorization names this collection and
 * this actor, on the actor's host, and the actor resolves. A document that
 * cannot be fetched rejects the item.
 */
const verifiedActor = async (
  context: ItemContext,
  objectUri: string,
  approvalUri: string,
): Promise<"rejected" | "unverified" | RemoteActor> => {
  const authorization = await fetchActivityJson(context.identity, approvalUri, context.options);
  if (authorization.isErr()) {
    return "rejected";
  }
  const document = authorization.value;
  const type: unknown = field(document, "type");
  const types = Array.isArray(type) ? type : [type];
  if (
    !sameHost(approvalUri, refId(field(document, "interactionTarget"))) ||
    !types.includes("FeatureAuthorization") ||
    refId(field(document, "interactingObject")) !== context.collectionUri ||
    refId(field(document, "interactionTarget")) !== objectUri
  ) {
    return "unverified";
  }
  const actor = await resolveRemoteActor(
    context.env.DB,
    context.identity,
    objectUri,
    context.options,
  );
  return actor.isOk() ? actor.value : "unverified";
};

/** `ProcessFeaturedItemService#call` for one item of the collection. */
const processItem = async (
  context: ItemContext,
  raw: unknown,
  position: number | undefined,
): Promise<Result<void, RepositoryError>> => {
  const fetched =
    typeof raw === "string"
      ? await fetchActivityJson(context.identity, raw, context.options)
      : ok(raw);
  if (fetched.isErr()) {
    return ok(undefined);
  }
  const json = fetched.value;
  const id = text(field(json, "id"));
  const objectUri = refId(field(json, "featuredObject"));
  const approvalUri = refId(field(json, "featureAuthorization"));
  if (id === undefined || objectUri === undefined || !sameHost(context.collectionUri, id)) {
    return ok(undefined);
  }
  const localName = parseLocalActorUsername(context.identity, objectUri);
  if (localName === undefined && !sameHost(objectUri, approvalUri)) {
    return ok(undefined);
  }
  const local =
    localName === undefined ? undefined : await findAccountByUsername(context.env.DB, localName);
  if (local?.isErr()) {
    return err(local.error);
  }
  const localAccount = local?.isOk() ? local.value : undefined;
  if (localName !== undefined && localAccount === undefined) {
    return ok(undefined);
  }
  const existing =
    context.rows.find((row) => row.uri === id) ??
    (localAccount === undefined
      ? undefined
      : context.rows.find(
          (row) =>
            row.uri === null && row.account_id === localAccount.id && row.state === "accepted",
        ));
  if (existing === undefined && context.rows.length >= RemoteCollection.itemsLimit) {
    return ok(undefined);
  }
  const at = nowIso();
  const published = text(field(json, "published"));
  const base = {
    id: existing?.id ?? newEntityId(),
    collectionId: context.collectionId,
    uri: id,
    objectUri,
    // `CollectionItem#set_position`: an item added on its own goes last.
    position:
      position ?? existing?.position ?? Math.max(0, ...context.rows.map((row) => row.position)) + 1,
    createdAt:
      existing?.created_at ??
      (published && !Number.isNaN(Date.parse(published)) ? new Date(published).toISOString() : at),
    activityUri: existing?.activity_uri ?? null,
  };
  if (localAccount !== undefined) {
    return saveRemoteItem(
      context.env.DB,
      {
        ...base,
        state: existing?.state === undefined ? "pending" : stateOf(existing.state),
        accountId: existing?.account_id ?? null,
        actorUri: null,
        approvalUri: existing?.approval_uri ?? null,
      },
      at,
    );
  }
  const verified =
    approvalUri === undefined ? "unverified" : await verifiedActor(context, objectUri, approvalUri);
  return saveRemoteItem(
    context.env.DB,
    {
      ...base,
      state:
        verified === "rejected"
          ? "rejected"
          : verified === "unverified"
            ? stateOf(existing?.state ?? "pending")
            : "accepted",
      accountId: null,
      actorUri: typeof verified === "object" ? verified.actorUri : (existing?.actor_uri ?? null),
      approvalUri:
        typeof verified === "object" ? (approvalUri ?? null) : (existing?.approval_uri ?? null),
    },
    at,
  );
};

const stateOf = (state: string): "pending" | "accepted" | "rejected" | "revoked" =>
  state === "accepted" || state === "rejected" || state === "revoked" ? state : "pending";

/**
 * `ActivityPub::ProcessFeaturedCollectionService`: a collection `actor`
 * federated, stored or updated, its items not in the document dropped and the
 * first 150 processed. A document from another host, or attributed to another
 * actor, is ignored.
 */
export const processRemoteCollection = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  json: unknown,
  options: FederatedFetchOptions,
): Promise<Result<RemoteCollection | undefined, RepositoryError>> => {
  const id = text(field(json, "id"));
  if (
    id === undefined ||
    !sameHost(actor.actorUri, id) ||
    field(json, "attributedTo") !== actor.actorUri
  ) {
    return ok(undefined);
  }
  const fields = collectionFields(actor, json, id);
  if (fields === undefined) {
    return ok(undefined);
  }
  const stored = await upsertRemoteCollection(env.DB, fields, nowIso());
  if (stored.isErr()) {
    return err(stored.error);
  }
  const orderedItems: unknown = field(json, "orderedItems");
  const items = (Array.isArray(orderedItems) ? orderedItems : []).slice(
    0,
    RemoteCollection.itemsLimit,
  );
  const kept = await deleteRemoteItemsExcept(
    env.DB,
    stored.value.id,
    items.flatMap((item) => refId(item) ?? []),
  );
  if (kept.isErr()) {
    return err(kept.error);
  }
  for (const [index, item] of items.entries()) {
    const rows = await listRemoteItemRows(env.DB, stored.value.id);
    if (rows.isErr()) {
      return err(rows.error);
    }
    const processed = await processItem(
      {
        env,
        identity,
        options,
        collectionId: stored.value.id,
        collectionUri: id,
        rows: rows.value,
      },
      item,
      index + 1,
    );
    if (processed.isErr()) {
      return err(processed.error);
    }
  }
  return findRemoteCollection(env.DB, stored.value.id);
};

/**
 * `FetchRemoteFeaturedCollectionService`: the collection at `uri`, stored
 * already or fetched and processed for its author, who must be `owner`.
 */
export const fetchRemoteCollection = async (
  env: Env,
  identity: InstanceIdentity,
  owner: RemoteActor,
  uri: string,
  options: FederatedFetchOptions,
): Promise<Result<RemoteCollection | undefined, RepositoryError>> => {
  const known = await findRemoteCollectionByUri(env.DB, uri);
  if (known.isErr() || known.value !== undefined) {
    return known.map((found) => (found?.actorUri === owner.actorUri ? found : undefined));
  }
  const fetched = await fetchActivityJson(identity, uri, options);
  if (fetched.isErr() || field(fetched.value, "type") !== "FeaturedCollection") {
    return ok(undefined);
  }
  return processRemoteCollection(env, identity, owner, fetched.value, options);
};

/** `Add#add_collection_item`: one item added to a stored collection of the actor. */
export const addRemoteCollectionItem = async (
  env: Env,
  identity: InstanceIdentity,
  collection: RemoteCollection,
  raw: unknown,
  options: FederatedFetchOptions,
): Promise<Result<void, RepositoryError>> => {
  const rows = await listRemoteItemRows(env.DB, collection.id);
  if (rows.isErr()) {
    return err(rows.error);
  }
  return processItem(
    {
      env,
      identity,
      options,
      collectionId: collection.id,
      collectionUri: collection.uri,
      rows: rows.value,
    },
    raw,
    undefined,
  );
};

/** `FetchFeaturedCollectionsCollectionService::MAX_PAGES` and `MAX_ITEMS`. */
const SYNCHRONIZE_PAGES = 10;
const SYNCHRONIZE_ITEMS = 50;

/**
 * `FetchFeaturedCollectionsCollectionService`: the actor's
 * `featuredCollections`, up to ten pages and fifty collections, each embedded
 * one processed and each one named by URI fetched.
 */
export const synchronizeRemoteCollections = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  options: FederatedFetchOptions,
): Promise<void> => {
  const uri = actor.profile.featuredCollectionsUri;
  if (uri === undefined) {
    return;
  }
  const items: unknown[] = [];
  let page = await firstCollectionPage(identity, uri, options);
  for (let read = 1; page !== undefined && items.length < SYNCHRONIZE_ITEMS; read += 1) {
    items.push(...page.items);
    page =
      page.next === undefined || read >= SYNCHRONIZE_PAGES
        ? undefined
        : await fetchCollectionPage(identity, page.next, options);
  }
  for (const item of items.slice(0, SYNCHRONIZE_ITEMS)) {
    if (typeof item === "string") {
      await fetchRemoteCollection(env, identity, actor, item, options);
    } else {
      await processRemoteCollection(env, identity, actor, item, options);
    }
  }
};
