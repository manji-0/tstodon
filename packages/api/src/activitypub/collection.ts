import { z } from "zod";
import { ApAnnounce, ApCreate } from "./activity";
import { ApContext, ApUri } from "./context";
import { ApHashtag } from "./note";

/**
 * An `OrderedCollection` with its items inline, for the small collections
 * Mastodon serves in one document (`featured`).
 */
const orderedCollection = <Item extends z.ZodType>(item: Item) =>
  z.object({
    "@context": ApContext,
    id: ApUri,
    type: z.literal("OrderedCollection"),
    totalItems: z.number().int().nonnegative(),
    orderedItems: z.array(item),
  });

/**
 * One page of a paged collection (Mastodon's `CollectionSerializer` given a
 * `part_of`): the items newest first, `next` to older items and `prev` to
 * newer ones.
 */
const orderedCollectionPage = <Item extends z.ZodType>(item: Item) =>
  z.object({
    "@context": ApContext,
    id: ApUri,
    type: z.literal("OrderedCollectionPage"),
    partOf: ApUri,
    next: ApUri.optional(),
    prev: ApUri.optional(),
    orderedItems: z.array(item),
  });

/**
 * A local account's `followers` / `following` collection, as Mastodon's
 * `FollowerAccountsController` / `FollowingAccountsController` serve it: the
 * account's count and a link to the first page. An account that hides its
 * collections serves the count without `first`, which Mastodon reads as hidden.
 */
export const ApActorCollection = z.object({
  "@context": ApContext,
  id: ApUri,
  type: z.literal("OrderedCollection"),
  totalItems: z.number().int().nonnegative(),
  first: ApUri.optional(),
});
export type ApActorCollectionJSON = z.infer<typeof ApActorCollection>;

/** A page of `followers` / `following`: actor URIs, newest follow first, and the count. */
export const ApActorCollectionPage = orderedCollectionPage(ApUri).extend({
  totalItems: z.number().int().nonnegative(),
});
export type ApActorCollectionPageJSON = z.infer<typeof ApActorCollectionPage>;

/**
 * A local account's followers on the signer's host, as Mastodon's
 * `FollowersSynchronizationsController` serves them (FEP-8fcf): every actor
 * URI in one document, unordered and without a count.
 */
export const ApFollowersSynchronizationCollection = z.object({
  "@context": ApContext,
  id: ApUri,
  type: z.literal("OrderedCollection"),
  orderedItems: z.array(ApUri),
});
export type ApFollowersSynchronizationCollectionJSON = z.infer<
  typeof ApFollowersSynchronizationCollection
>;

/**
 * A local account's `featured` collection: its pinned statuses, newest pin
 * first, as their URIs. Mastodon embeds the notes it may distribute; a reader
 * resolves either form.
 */
export const ApFeaturedCollection = orderedCollection(ApUri);
export type ApFeaturedCollectionJSON = z.infer<typeof ApFeaturedCollection>;

/**
 * A local account's `featuredTags` collection: its featured hashtags, as
 * Mastodon's `CollectionsController` serves `tags` (an unordered collection
 * of `Hashtag` objects).
 */
export const ApFeaturedTagsCollection = z.object({
  "@context": ApContext,
  id: ApUri,
  type: z.literal("Collection"),
  totalItems: z.number().int().nonnegative(),
  items: z.array(ApHashtag),
});
export type ApFeaturedTagsCollectionJSON = z.infer<typeof ApFeaturedTagsCollection>;

/**
 * A local account's outbox, as Mastodon's `OutboxesController` serves it
 * without `page`: the account's status count, and links to its newest
 * (`first`) and oldest (`last`) pages.
 */
export const ApOutbox = z.object({
  "@context": ApContext,
  id: ApUri,
  type: z.literal("OrderedCollection"),
  totalItems: z.number().int().nonnegative(),
  first: ApUri,
  last: ApUri,
});
export type ApOutboxJSON = z.infer<typeof ApOutbox>;

/**
 * A page of a local account's outbox: the statuses and boosts the fetcher
 * may read, as a `Create` of the note as it is now or an `Announce`, each
 * with its `@context`. Like Mastodon's, it carries no `totalItems`.
 */
export const ApOutboxPage = orderedCollectionPage(
  z.discriminatedUnion("type", [
    ApCreate.extend({ "@context": ApContext }),
    ApAnnounce.extend({ "@context": ApContext }),
  ]),
);
export type ApOutboxPageJSON = z.infer<typeof ApOutboxPage>;
