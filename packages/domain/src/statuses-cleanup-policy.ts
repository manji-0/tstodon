import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { type Visibility } from "./visibility";

/**
 * An account's automated post deletion, as Mastodon's "Automated post
 * deletion" settings (`/statuses_cleanup`) model it: delete the account's
 * posts older than `minAgeSeconds` unless a keep rule protects them.
 */

const WEEK = 7 * 24 * 60 * 60;

/** Mastodon's choices for the minimum age, in seconds, with their labels. */
export const MIN_AGE_CHOICES = [
  { seconds: WEEK, label: "1 week" },
  { seconds: 2 * WEEK, label: "2 weeks" },
  { seconds: 2_629_746, label: "1 month" },
  { seconds: 5_259_492, label: "2 months" },
  { seconds: 15_778_476, label: "6 months" },
  { seconds: 31_556_952, label: "1 year" },
  { seconds: 63_113_904, label: "2 years" },
] as const;

const MinAgeSchema = z.union([
  z.literal(MIN_AGE_CHOICES[0].seconds),
  z.literal(MIN_AGE_CHOICES[1].seconds),
  z.literal(MIN_AGE_CHOICES[2].seconds),
  z.literal(MIN_AGE_CHOICES[3].seconds),
  z.literal(MIN_AGE_CHOICES[4].seconds),
  z.literal(MIN_AGE_CHOICES[5].seconds),
  z.literal(MIN_AGE_CHOICES[6].seconds),
]);

/** A "keep posts with at least N" rule: off, or on with its threshold. */
const InteractionThresholdSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Off") }),
  z.object({ kind: z.literal("AtLeast"), count: z.number().int().positive() }),
]);

const RulesSchema = z.object({
  minAgeSeconds: MinAgeSchema,
  keepPinned: z.boolean(),
  keepDirect: z.boolean(),
  keepSelfFavourited: z.boolean(),
  keepSelfBookmarked: z.boolean(),
  keepPolls: z.boolean(),
  keepMedia: z.boolean(),
  keepFavourites: InteractionThresholdSchema,
  keepBoosts: InteractionThresholdSchema,
});

/** Both variants keep the rules, so switching the policy off loses no setting. */
export const StatusesCleanupPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Disabled"), rules: RulesSchema }),
  z.object({ kind: z.literal("Enabled"), rules: RulesSchema }),
]);

export type StatusesCleanupPolicy = z.infer<typeof StatusesCleanupPolicySchema>;
export type StatusesCleanupRules = z.infer<typeof RulesSchema>;
export type InteractionThreshold = z.infer<typeof InteractionThresholdSchema>;

/** What the decision needs to know about one of the account's posts. */
export type StatusCleanupFacts = Readonly<{
  /** When the post was published, as milliseconds since the epoch. */
  createdAtMs: number;
  visibility: Visibility;
  pinned: boolean;
  /** The account favourited its own post. */
  favouritedBySelf: boolean;
  /** The account bookmarked its own post. */
  bookmarkedBySelf: boolean;
  hasPoll: boolean;
  hasMedia: boolean;
  favouritesCount: number;
  boostsCount: number;
}>;

const reachesThreshold = (threshold: InteractionThreshold, count: number): boolean =>
  threshold.kind === "AtLeast" && count >= threshold.count;

/** Mastodon's defaults for an account that never saved the page: off, 2 weeks. */
const defaultPolicy: StatusesCleanupPolicy = {
  kind: "Disabled",
  rules: {
    minAgeSeconds: 2 * WEEK,
    keepPinned: true,
    keepDirect: true,
    keepSelfFavourited: true,
    keepSelfBookmarked: true,
    keepPolls: false,
    keepMedia: false,
    keepFavourites: { kind: "Off" },
    keepBoosts: { kind: "Off" },
  },
};

export const StatusesCleanupPolicy = {
  schema: StatusesCleanupPolicySchema,
  parse: schemaResult(StatusesCleanupPolicySchema),
  default: defaultPolicy,
  /**
   * Whether the automated deletion removes this post now. A disabled policy
   * removes nothing; an enabled one removes a post that is old enough and that
   * no keep rule protects.
   */
  shouldDelete: (
    policy: StatusesCleanupPolicy,
    facts: StatusCleanupFacts,
    nowMs: number,
  ): boolean => {
    if (policy.kind === "Disabled") {
      return false;
    }
    const rules = policy.rules;
    if (facts.createdAtMs > nowMs - rules.minAgeSeconds * 1000) {
      return false;
    }
    const kept =
      (rules.keepPinned && facts.pinned) ||
      (rules.keepDirect && facts.visibility.kind === "Direct") ||
      (rules.keepSelfFavourited && facts.favouritedBySelf) ||
      (rules.keepSelfBookmarked && facts.bookmarkedBySelf) ||
      (rules.keepPolls && facts.hasPoll) ||
      (rules.keepMedia && facts.hasMedia) ||
      reachesThreshold(rules.keepFavourites, facts.favouritesCount) ||
      reachesThreshold(rules.keepBoosts, facts.boostsCount);
    return !kept;
  },
} as const;
