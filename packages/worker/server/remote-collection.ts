import type { InstanceIdentity } from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { z } from "zod";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";

/**
 * Items read per collection page unless the reader asks for more: a
 * profile's first screen. Each referenced item can cost a fetch, so this
 * bounds one job's subrequests.
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

/**
 * How a reader takes a collection's pages: up to `itemLimit` items a page, and
 * with `origin`, a `first` page only when its link is on that origin, as
 * Mastodon's `fetch_collection_page` checks a link against `reference_uri`.
 */
export type PageReading = Readonly<{ itemLimit: number; origin?: string | undefined }>;

const DEFAULT_READING: PageReading = { itemLimit: COLLECTION_PAGE_ITEM_LIMIT };

/** One page of a collection: its newest items, and the link to the page after it. */
export type CollectionPage = Readonly<{ items: ReadonlyArray<unknown>; next: string | undefined }>;

const resolveLink = (link: string, base: string): string | undefined => {
  try {
    return new URL(link, base).href;
  } catch {
    return undefined;
  }
};

const pageOf = (
  page: z.infer<typeof CollectionPageSchema>,
  pageUri: string,
  itemLimit: number,
): CollectionPage => ({
  items: pageItems(page).slice(0, itemLimit),
  next: page.next === undefined ? undefined : resolveLink(page.next, pageUri),
});

/**
 * A collection page by its link. `Unavailable` when its server did not answer
 * (a timeout, a 5xx, a fetch the runtime refused), which a later try may
 * read; undefined when what it answered is no page.
 */
export const readCollectionPage = async (
  identity: InstanceIdentity,
  pageUri: string,
  options: FederatedFetchOptions,
  reading: PageReading = DEFAULT_READING,
): Promise<CollectionPage | "Unavailable" | undefined> => {
  const raw = await fetchActivityJson(identity, pageUri, options);
  if (raw.isErr()) {
    return raw.error.kind === "VerificationUnavailable" ? "Unavailable" : undefined;
  }
  const parsed = parseCollectionPage(raw.value);
  return parsed.isOk() ? pageOf(parsed.value, pageUri, reading.itemLimit) : undefined;
};

/** A collection page by its link. Undefined when it could not be read. */
export const fetchCollectionPage = async (
  identity: InstanceIdentity,
  pageUri: string,
  options: FederatedFetchOptions,
  reading: PageReading = DEFAULT_READING,
): Promise<CollectionPage | undefined> => {
  const page = await readCollectionPage(identity, pageUri, options, reading);
  return page === "Unavailable" ? undefined : page;
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
  reading: PageReading = DEFAULT_READING,
): Promise<CollectionPage | undefined> => {
  const first = collection.first;
  if (pageItems(collection).length > 0 || first === undefined) {
    return pageOf(collection, collectionUri, reading.itemLimit);
  }
  if (typeof first !== "string") {
    return pageOf(first, collectionUri, reading.itemLimit);
  }
  const firstUri = resolveLink(first, collectionUri);
  if (
    firstUri === undefined ||
    (reading.origin !== undefined && URL.parse(firstUri)?.origin !== reading.origin)
  ) {
    return undefined;
  }
  return fetchCollectionPage(identity, firstUri, options, reading);
};

/**
 * The first page of the collection at `collectionUri`. Undefined when it
 * could not be read, as opposed to an empty one.
 */
export const firstCollectionPage = async (
  identity: InstanceIdentity,
  collectionUri: string,
  options: FederatedFetchOptions,
  reading: PageReading = DEFAULT_READING,
): Promise<CollectionPage | undefined> => {
  const raw = await fetchActivityJson(identity, collectionUri, options);
  const collection = raw.isOk() ? parseCollection(raw.value) : undefined;
  return collection?.isOk()
    ? firstPageOf(identity, collection.value, collectionUri, options, reading)
    : undefined;
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([CollectionSchema, CollectionPageSchema]);
