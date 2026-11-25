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
  /** A remote account's item: the `FeatureRequest` sent for it. */
  activityUri: z.string().optional(),
  /** A remote account's item: the authorization its `Accept` named. */
  approvalUri: z.string().optional(),
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

/**
 * A remote account's collection (Mastodon 4.7 `Collection` with
 * `local: false`), as `ProcessFeaturedCollectionService` stores it.
 * `accountId` is the owner's `r_…` id; `items` are those whose account is
 * known (a local account, or a remote one its authorization verified).
 */
export const RemoteCollectionSchema = z.object({
  kind: z.literal("RemoteCollection"),
  id: z.string().min(1),
  accountId: AccountId.schema,
  actorUri: z.string().min(1),
  uri: z.string().min(1),
  url: z.string().min(1),
  name: z.string(),
  descriptionHtml: z.string(),
  language: z.string().nullable(),
  sensitive: z.boolean(),
  discoverable: z.boolean(),
  originalNumberOfItems: z.number().int().nonnegative(),
  tagName: z.string().nullable(),
  createdAt: IsoInstant.schema,
  updatedAt: IsoInstant.schema,
  items: z.array(CollectionItemSchema).readonly(),
});
export type RemoteCollection = z.infer<typeof RemoteCollectionSchema>;

export const RemoteCollection = {
  schema: RemoteCollectionSchema,
  parse: schemaResult(RemoteCollectionSchema),
  /** `ProcessFeaturedCollectionService::ITEMS_LIMIT`. */
  itemsLimit: 150,
  /** `Collection::NAME_LENGTH_HARD_LIMIT` and `DESCRIPTION_LENGTH_HARD_LIMIT`. */
  nameLimit: 256,
  descriptionLimit: 2048,
  /**
   * `NotifyOfCollectionUpdateService#significantly_changed?` after
   * `ProcessFeaturedCollectionService`: the name, the summary, the
   * sensitivity or the topic.
   */
  significantlyChanged: (before: RemoteCollection, after: RemoteCollection): boolean =>
    before.name !== after.name ||
    before.descriptionHtml !== after.descriptionHtml ||
    before.sensitive !== after.sensitive ||
    before.tagName !== after.tagName,
} as const;

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
  collection: Collection | RemoteCollection,
  viewerId: string | undefined,
  blockedByViewer: ReadonlySet<string>,
): ReadonlyArray<CollectionItem> =>
  collection.items.filter(
    (item) =>
      (viewerId === collection.accountId ? live(item) : item.state === "accepted") &&
      !blockedByViewer.has(item.accountId),
  );

const PolicyFlagsSchema = z.object({
  public: z.boolean(),
  followers: z.boolean(),
  following: z.boolean(),
  unsupported: z.boolean(),
  disabled: z.boolean(),
});
type PolicyFlags = z.infer<typeof PolicyFlagsSchema>;

/**
 * A remote account's `interactionPolicy.canFeature`, as Mastodon's
 * `InteractionPolicyParser` reads it into `feature_approval_policy`: who
 * may feature it without asking (`automatic`) and who may ask (`manual`).
 */
export const FeaturePolicySchema = z.object({
  automatic: PolicyFlagsSchema,
  manual: PolicyFlagsSchema,
});
export type FeaturePolicy = z.infer<typeof FeaturePolicySchema>;

const PUBLIC_NAMES: ReadonlySet<string> = new Set([
  "as:Public",
  "Public",
  "https://www.w3.org/ns/activitystreams#Public",
]);

/** `InteractionPolicyParser#subpolicy`: the flags of one approval list. */
const subpolicy = (
  value: unknown,
  actor: Readonly<{ actorUri: string; followersUri?: string; followingUri?: string }>,
): PolicyFlags => {
  const listed = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value];
  const left = new Set<unknown>(listed);
  const take = (match: (entry: unknown) => boolean): boolean => {
    let found = false;
    for (const entry of [...left]) {
      if (match(entry)) {
        left.delete(entry);
        found = true;
      }
    }
    return found;
  };
  const flags = {
    public: take((entry) => typeof entry === "string" && PUBLIC_NAMES.has(entry)),
    followers: actor.followersUri !== undefined && take((entry) => entry === actor.followersUri),
    following: actor.followingUri !== undefined && take((entry) => entry === actor.followingUri),
  };
  const includesTarget = take((entry) => entry === actor.actorUri);
  const unsupported = left.size > 0;
  const none = !flags.public && !flags.followers && !flags.following && !unsupported;
  return { ...flags, unsupported, disabled: none && includesTarget };
};

const anyFlag = (flags: PolicyFlags): boolean =>
  flags.public || flags.followers || flags.following || flags.unsupported || flags.disabled;

/**
 * `InteractionPolicyParser#bitmap` of an actor's `canFeature`; `undefined`
 * for the empty bitmap, which Mastodon reads as `:missing`.
 */
const parseFeaturePolicy = (
  canFeature: unknown,
  actor: Readonly<{ actorUri: string; followersUri?: string; followingUri?: string }>,
): FeaturePolicy | undefined => {
  if (typeof canFeature !== "object" || canFeature === null) {
    return undefined;
  }
  const policy = {
    automatic: subpolicy(Reflect.get(canFeature, "automaticApproval"), actor),
    manual: subpolicy(Reflect.get(canFeature, "manualApproval"), actor),
  };
  return anyFlag(policy.automatic) || anyFlag(policy.manual) ? policy : undefined;
};

/**
 * What `AccountPolicy#feature?` reads when an account is to be featured in
 * `ownerId`'s collection: a local account's flags, or a remote account's
 * federated policy. The follows are the owner's of the target and the
 * target's of the owner.
 */
export type FeatureCandidate =
  | Readonly<{
      kind: "Local";
      ownerId: string;
      targetId: string;
      targetDiscoverable: boolean;
      targetLocked: boolean;
      ownerFollowsTarget: boolean;
      blockedEitherWay: boolean;
    }>
  | Readonly<{
      kind: "Remote";
      policy: FeaturePolicy | undefined;
      ownerFollowsTarget: boolean;
      targetFollowsOwner: boolean;
      blockedEitherWay: boolean;
    }>;

export type FeatureApproval = "automatic" | "manual" | "unknown" | "missing" | "denied";

const allows = (
  flags: PolicyFlags,
  candidate: Readonly<{ ownerFollowsTarget: boolean; targetFollowsOwner: boolean }>,
): boolean =>
  flags.public ||
  (flags.followers && candidate.ownerFollowsTarget) ||
  (flags.following && candidate.targetFollowsOwner);

/** `Account#feature_policy_for_account`. */
const featureApproval = (candidate: FeatureCandidate): FeatureApproval => {
  switch (candidate.kind) {
    case "Local":
      if (!candidate.targetDiscoverable) {
        return "denied";
      }
      return candidate.targetLocked &&
        !candidate.ownerFollowsTarget &&
        candidate.ownerId !== candidate.targetId
        ? "denied"
        : "automatic";
    case "Remote": {
      const { policy } = candidate;
      if (policy === undefined) {
        return "missing";
      }
      if (allows(policy.automatic, candidate)) {
        return "automatic";
      }
      if (allows(policy.manual, candidate)) {
        return "manual";
      }
      return policy.automatic.unsupported || policy.manual.unsupported ? "unknown" : "denied";
    }
    default:
      return candidate satisfies never;
  }
};

/** `InteractionPolicy::POLICY_FLAGS`, in their bit order, as `SubPolicy#as_keys` names them. */
export type FeaturePolicyKey =
  | "unsupported_policy"
  | "public"
  | "followers"
  | "following"
  | "disabled";

/** `SubPolicy#as_keys`: the flags set, in bit order. */
const policyKeys = (flags: PolicyFlags): FeaturePolicyKey[] => [
  ...(flags.unsupported ? (["unsupported_policy"] as const) : []),
  ...(flags.public ? (["public"] as const) : []),
  ...(flags.followers ? (["followers"] as const) : []),
  ...(flags.following ? (["following"] as const) : []),
  ...(flags.disabled ? (["disabled"] as const) : []),
];

export type FeaturePolicyKeys = Readonly<{
  automatic: ReadonlyArray<FeaturePolicyKey>;
  manual: ReadonlyArray<FeaturePolicyKey>;
}>;

/**
 * `Account#feature_policy_as_keys`: a local account's from its flags
 * (`local_feature_policy`: none unless discoverable, then its followers when
 * locked and anyone when not, never manual), a remote one's as federated.
 */
const featurePolicyKeys = (
  account:
    | Readonly<{ kind: "Local"; discoverable: boolean; locked: boolean }>
    | Readonly<{ kind: "Remote"; policy: FeaturePolicy | undefined }>,
): FeaturePolicyKeys => {
  switch (account.kind) {
    case "Local":
      return {
        automatic: account.discoverable ? [account.locked ? "followers" : "public"] : [],
        manual: [],
      };
    case "Remote":
      return account.policy === undefined
        ? { automatic: [], manual: [] }
        : {
            automatic: policyKeys(account.policy.automatic),
            manual: policyKeys(account.policy.manual),
          };
    default:
      return account satisfies never;
  }
};

/**
 * Whether `feature_policy_for_account` of a remote account reads how the
 * viewer and it follow each other: its policy names followers or following
 * and does not let anyone feature it without asking.
 */
const featureApprovalReadsFollows = (policy: FeaturePolicy | undefined): boolean =>
  policy !== undefined &&
  !policy.automatic.public &&
  [policy.automatic, policy.manual].some((flags) => flags.followers || flags.following);

/**
 * `AccountPolicy#feature?`: `Account#featureable_by?` (an automatic or a
 * manual approval) and no block either way.
 */
const featureable = (candidate: FeatureCandidate): boolean => {
  const approval = featureApproval(candidate);
  return (approval === "automatic" || approval === "manual") && !candidate.blockedEitherWay;
};

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
  featureApproval,
  featureApprovalReadsFollows,
  featurePolicyKeys,
  parseFeaturePolicy,
  significantlyChanged,
} as const;

export const CollectionItem = {
  schema: CollectionItemSchema,
  parse: schemaResult(CollectionItemSchema),
} as const;
