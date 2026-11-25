import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { AccountId } from "./account-id";
import { IsoInstant } from "./iso-instant";

/** `CollectionItem#state`, Mastodon's enum. */
export const COLLECTION_ITEM_STATES = ["pending", "accepted", "rejected", "revoked"] as const;

const CollectionItemSchema = z.object({
  id: z.string().min(1),
  accountId: AccountId.schema,
  position: z.number().int().positive(),
  state: z.literal(COLLECTION_ITEM_STATES),
  createdAt: IsoInstant.schema,
});

export type CollectionItem = z.infer<typeof CollectionItemSchema>;
export type CollectionItemState = CollectionItem["state"];

/**
 * A local account's collection (Mastodon 4.7 `Collection` with `local: true`).
 * `items` are every item it holds, in `position` order, whatever their state.
 */
const LocalCollectionSchema = z.object({
  kind: z.literal("LocalCollection"),
  id: z.string().min(1),
  accountId: AccountId.schema,
  name: z.string(),
  description: z.string().nullable(),
  language: z.string().nullable(),
  sensitive: z.boolean(),
  discoverable: z.boolean(),
  tagName: z.string().nullable(),
  createdAt: IsoInstant.schema,
  updatedAt: IsoInstant.schema,
  items: z.array(CollectionItemSchema).readonly(),
});

export const CollectionSchema = z.discriminatedUnion("kind", [LocalCollectionSchema]);
export type Collection = z.infer<typeof CollectionSchema>;

/** The fields a client sets, as Rails casts them: `null` where the param was blank or absent. */
export type CollectionFields = Readonly<{
  name: string | null;
  description: string | null;
  language: string | null;
  sensitive: boolean | null;
  discoverable: boolean | null;
  tagName: string | null;
}>;

/**
 * One of `Collection`'s validation errors: the attribute, Rails' error type
 * (`ERR_<TYPE>` in `ValidationErrorFormatter`), and its message.
 */
export type CollectionValidationError = Readonly<{
  attribute:
    | "name"
    | "description"
    | "sensitive"
    | "discoverable"
    | "language"
    | "tag_name"
    | "collection_items"
    | "base";
  error: "blank" | "too_long" | "inclusion" | "invalid" | "unusable" | "too_many";
  message: string;
}>;

/** What validating a collection reads besides its fields. */
export type CollectionValidationContext = Readonly<{
  /** Whether the topic tag is usable (`Tag#usable?`); true without a topic. */
  tagUsable: boolean;
  /** The pending or accepted items the collection would hold. */
  liveItemCount: number;
  /** Whether `language` is a known language code (`LanguageValidator`). */
  knownLanguage: (code: string) => boolean;
  /** On create: the owner's collections so far and its role's `collection_limit`. */
  ownerQuota: Readonly<{ count: number; limit: number }> | undefined;
}>;

/** `Collection::MAX_ITEMS`. */
const MAX_ITEMS = 25;
/** The length limits of a local collection's `name` and `description`. */
const NAME_MAX = 40;
const DESCRIPTION_MAX = 100;
/** `UserRole#collection_limit`'s default, the limit every tstodon role has. */
const COLLECTION_LIMIT = 10;

/** Ruby's `String#length`: characters, not UTF-16 units. */
const characters = (value: string): number => Array.from(value).length;
const blank = (value: string | null): boolean => value === null || value.trim() === "";
/**
 * The message Rails renders for an error key no locale defines: Mastodon
 * 4.7.5 adds `unusable` to `tag_name` (its locale has it under `tag`) and
 * `too_many` to `base` (no locale has it).
 */
const missingTranslation = (attribute: string, error: string): string =>
  `Translation missing: en.activerecord.errors.models.collection.attributes.${attribute}.${error}`;

const tooLong = (
  attribute: "name" | "description",
  value: string | null,
  max: number,
): CollectionValidationError[] =>
  value !== null && characters(value) > max
    ? [{ attribute, error: "too_long", message: `is too long (maximum is ${max} characters)` }]
    : [];

const inclusion = (
  attribute: "sensitive" | "discoverable",
  value: boolean | null,
): CollectionValidationError[] =>
  value === null ? [{ attribute, error: "inclusion", message: "is not included in the list" }] : [];

/**
 * A local collection's validations, in the order `Collection` declares them
 * (so the joined message reads as Rails'). `ownerQuota` is checked on create
 * only (`on: :create`).
 */
const validate = (
  fields: CollectionFields,
  context: CollectionValidationContext,
): ReadonlyArray<CollectionValidationError> => [
  ...(blank(fields.name)
    ? [{ attribute: "name", error: "blank", message: "can't be blank" } as const]
    : []),
  ...tooLong("name", fields.name, NAME_MAX),
  ...tooLong("description", fields.description, DESCRIPTION_MAX),
  ...inclusion("sensitive", fields.sensitive),
  ...inclusion("discoverable", fields.discoverable),
  ...(fields.language !== null && !context.knownLanguage(fields.language)
    ? [{ attribute: "language", error: "invalid", message: "is invalid" } as const]
    : []),
  ...(context.tagUsable
    ? []
    : [
        {
          attribute: "tag_name",
          error: "unusable",
          message: missingTranslation("tag_name", "unusable"),
        } as const,
      ]),
  ...(context.liveItemCount > MAX_ITEMS
    ? [
        {
          attribute: "collection_items",
          error: "too_many",
          message: `are too many, no more than ${MAX_ITEMS} are allowed`,
        } as const,
      ]
    : []),
  ...(context.ownerQuota !== undefined && context.ownerQuota.count >= context.ownerQuota.limit
    ? [
        {
          attribute: "base",
          error: "too_many",
          message: missingTranslation("base", "too_many"),
        } as const,
      ]
    : []),
];

const HUMAN_ATTRIBUTES: Readonly<Record<CollectionValidationError["attribute"], string>> = {
  name: "Name",
  description: "Description",
  sensitive: "Sensitive",
  discoverable: "Discoverable",
  language: "Language",
  tag_name: "Tag name",
  collection_items: "Collection items",
  base: "",
};

/** Rails' `full_message`: the humanized attribute and the message, or the message alone on `base`. */
const fullMessage = (error: CollectionValidationError): string =>
  error.attribute === "base"
    ? error.message
    : `${HUMAN_ATTRIBUTES[error.attribute]} ${error.message}`;

const live = (item: CollectionItem): boolean =>
  item.state === "pending" || item.state === "accepted";

/**
 * `Collection#items_for`: the owner sees its pending and accepted items,
 * anyone else the accepted ones; a signed-in viewer does not see the
 * accounts it blocks.
 */
const itemsFor = (
  collection: Collection,
  viewerId: string | undefined,
  blockedByViewer: ReadonlySet<string>,
): ReadonlyArray<CollectionItem> =>
  collection.items.filter(
    (item) =>
      (viewerId === collection.accountId ? live(item) : item.state === "accepted") &&
      !blockedByViewer.has(item.accountId),
  );

/**
 * What `AccountPolicy#feature?` reads when a local account is to be featured
 * in `owner`'s collection.
 */
export type FeatureCandidate = Readonly<{
  ownerId: string;
  targetId: string;
  targetDiscoverable: boolean;
  targetLocked: boolean;
  ownerFollowsTarget: boolean;
  blockedEitherWay: boolean;
}>;

/**
 * `AccountPolicy#feature?` for a local target: `Account#featureable_by?`
 * (discoverable, and unlocked, followed by the owner, or the owner itself)
 * and no block either way.
 */
const featureable = (candidate: FeatureCandidate): boolean =>
  candidate.targetDiscoverable &&
  (!candidate.targetLocked ||
    candidate.ownerFollowsTarget ||
    candidate.ownerId === candidate.targetId) &&
  !candidate.blockedEitherWay;

/**
 * `NotifyOfCollectionUpdateService#significantly_changed?`: a change of the
 * name, description, sensitivity or topic notifies the featured accounts.
 */
const significantlyChanged = (before: Collection, after: Collection): boolean =>
  before.name !== after.name ||
  before.description !== after.description ||
  before.sensitive !== after.sensitive ||
  before.tagName !== after.tagName;

export const Collection = {
  schema: CollectionSchema,
  parse: schemaResult(CollectionSchema),
  maxItems: MAX_ITEMS,
  limit: COLLECTION_LIMIT,
  validate,
  fullMessage,
  itemsFor,
  live,
  featureable,
  significantlyChanged,
} as const;

export const CollectionItem = {
  schema: CollectionItemSchema,
  parse: schemaResult(CollectionItemSchema),
} as const;
