import { z } from "zod";
import { ApContext, ApUri, withContext } from "./context";
import { ApHashtag } from "./hashtag";

/**
 * A collection's item as FEP-7aa9 names it (`ActivityPub::FeaturedItemSerializer`):
 * the featured actor and the authorization its server gave.
 */
export const ApFeaturedItem = z.object({
  id: ApUri,
  type: z.literal("FeaturedItem"),
  featuredObject: ApUri,
  featureAuthorization: ApUri,
  published: z.iso.datetime(),
});
export type ApFeaturedItemJSON = z.infer<typeof ApFeaturedItem>;

/**
 * A curated collection of accounts, FEP-7aa9's `FeaturedCollection`
 * (`ActivityPub::FeaturedCollectionSerializer`), with its accepted items.
 * Not to be confused with `featured`, the pinned statuses. `summary` without
 * a language, `summaryMap` with one; `topic` is `null` without one.
 */
export const ApCuratedCollection = z.object({
  id: ApUri,
  type: z.literal("FeaturedCollection"),
  totalItems: z.number().int().nonnegative(),
  name: z.string(),
  attributedTo: ApUri,
  url: ApUri,
  sensitive: z.boolean(),
  discoverable: z.boolean(),
  published: z.iso.datetime(),
  updated: z.iso.datetime(),
  summary: z.string().nullable().optional(),
  summaryMap: z.record(z.string(), z.string().nullable()).optional(),
  topic: ApHashtag.nullable(),
  orderedItems: z.array(ApFeaturedItem),
});
export type ApCuratedCollectionJSON = z.infer<typeof ApCuratedCollection>;

export const ApCuratedCollectionDocument = withContext(ApCuratedCollection);
export type ApCuratedCollectionDocumentJSON = z.infer<typeof ApCuratedCollectionDocument>;

export const ApFeaturedItemDocument = withContext(ApFeaturedItem);
export type ApFeaturedItemDocumentJSON = z.infer<typeof ApFeaturedItemDocument>;

/**
 * The featured account's consent to an item (`ActivityPub::FeatureAuthorizationSerializer`):
 * the collection it may appear in and the account itself.
 */
export const ApFeatureAuthorization = z.object({
  id: ApUri,
  type: z.literal("FeatureAuthorization"),
  interactingObject: ApUri,
  interactionTarget: ApUri,
});
export type ApFeatureAuthorizationJSON = z.infer<typeof ApFeatureAuthorization>;

/**
 * A collection owner's ask to feature an account (`ActivityPub::FeatureRequestSerializer`):
 * the account as `object`, the collection as `instrument`. Mastodon sends it
 * without an `actor`; the signature names the owner.
 */
export const ApFeatureRequest = z.object({
  id: ApUri,
  type: z.literal("FeatureRequest"),
  object: ApUri,
  instrument: ApUri,
});
export type ApFeatureRequestJSON = z.infer<typeof ApFeatureRequest>;

export const ApFeatureAuthorizationDocument = withContext(ApFeatureAuthorization);
export type ApFeatureAuthorizationDocumentJSON = z.infer<typeof ApFeatureAuthorizationDocument>;

/**
 * An actor's `featuredCollections` (`ActivityPub::FeaturedCollectionsController`):
 * an unordered collection whose `first` page holds the collections.
 */
export const ApFeaturedCollections = z.object({
  "@context": ApContext,
  id: ApUri,
  type: z.literal("Collection"),
  totalItems: z.number().int().nonnegative(),
  first: ApUri,
});
export type ApFeaturedCollectionsJSON = z.infer<typeof ApFeaturedCollections>;

/** One page of `featuredCollections`, five collections each. */
export const ApFeaturedCollectionsPage = z.object({
  "@context": ApContext,
  id: ApUri,
  type: z.literal("CollectionPage"),
  totalItems: z.number().int().nonnegative(),
  next: ApUri.optional(),
  prev: ApUri.optional(),
  partOf: ApUri,
  items: z.array(ApCuratedCollection),
});
export type ApFeaturedCollectionsPageJSON = z.infer<typeof ApFeaturedCollectionsPage>;
