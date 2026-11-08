import type { InstanceIdentity } from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { z } from "zod";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";

/**
 * Items read per collection page: a profile's or thread's first screen. Each
 * referenced item can cost a fetch, so this bounds one job's subrequests.
 */
export const COLLECTION_PAGE_ITEM_LIMIT = 20;

const CollectionPageSchema = z
  .object({
    orderedItems: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional(),
    next: z.string().min(1).optional(),
  })
  .passthrough();

const CollectionSchema = CollectionPageSchema.extend({
  first: z.union([z.string().min(1), CollectionPageSchema]).optional(),
});

/** A collection as a remote serves it: its own items, or a `first` page (embedded or a link). */
export type RemoteCollection = z.infer<typeof CollectionSchema>;

export const parseCollection = schemaResult(CollectionSchema);
const parseCollectionPage = schemaResult(CollectionPageSchema);

const pageItems = (page: z.infer<typeof CollectionPageSchema>): ReadonlyArray<unknown> =>
  page.orderedItems ?? page.items ?? [];

/** One page of a collection: its newest items, and the link to the page after it. */
export type CollectionPage = Readonly<{ items: ReadonlyArray<unknown>; next: string | undefined }>;

const resolveLink = (link: string, base: string): string | undefined => {
  try {
    return new URL(link, base).href;
  } catch {
    return undefined;
  }
};

const pageOf = (page: z.infer<typeof CollectionPageSchema>, pageUri: string): CollectionPage => ({
  items: pageItems(page).slice(0, COLLECTION_PAGE_ITEM_LIMIT),
  next: page.next === undefined ? undefined : resolveLink(page.next, pageUri),
});

/** A collection page by its link. Undefined when it could not be read. */
export const fetchCollectionPage = async (
  identity: InstanceIdentity,
  pageUri: string,
  options: FederatedFetchOptions,
): Promise<CollectionPage | undefined> => {
  const raw = await fetchActivityJson(identity, pageUri, options);
  const parsed = raw.isOk() ? parseCollectionPage(raw.value) : undefined;
  return parsed?.isOk() ? pageOf(parsed.value, pageUri) : undefined;
};

/**
 * The first page of a collection already read from `collectionUri`: its own
 * items, or its `first` page's.
 */
export const firstPageOf = async (
  identity: InstanceIdentity,
  collection: RemoteCollection,
  collectionUri: string,
  options: FederatedFetchOptions,
): Promise<CollectionPage | undefined> => {
  const first = collection.first;
  if (pageItems(collection).length > 0 || first === undefined) {
    return pageOf(collection, collectionUri);
  }
  if (typeof first !== "string") {
    return pageOf(first, collectionUri);
  }
  const firstUri = resolveLink(first, collectionUri);
  return firstUri ? fetchCollectionPage(identity, firstUri, options) : undefined;
};

/**
 * The first page of the collection at `collectionUri`. Undefined when it
 * could not be read, as opposed to an empty one.
 */
export const firstCollectionPage = async (
  identity: InstanceIdentity,
  collectionUri: string,
  options: FederatedFetchOptions,
): Promise<CollectionPage | undefined> => {
  const raw = await fetchActivityJson(identity, collectionUri, options);
  const collection = raw.isOk() ? parseCollection(raw.value) : undefined;
  return collection?.isOk()
    ? firstPageOf(identity, collection.value, collectionUri, options)
    : undefined;
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([CollectionSchema, CollectionPageSchema]);
