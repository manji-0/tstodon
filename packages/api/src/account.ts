import { z } from "zod";
import { ApiCustomEmoji } from "./custom-emoji";
import {
  FEATURE_POLICIES,
  QUOTE_POLICIES,
  STATUS_VISIBILITIES,
  USER_FEATURE_POLICIES,
} from "./values";

/** `Account#fields[]`: `value` is HTML. */
export const ApiAccountField = z.object({
  name: z.string(),
  value: z.string(),
  verified_at: z.string().nullable(),
});
export type ApiAccountFieldJSON = z.infer<typeof ApiAccountField>;

/** `Account#roles[]` (`REST::AccountSerializer::RoleSerializer`): highlighted roles only. */
export const ApiAccountRole = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});
export type ApiAccountRoleJSON = z.infer<typeof ApiAccountRole>;

/** `Account#feature_approval` (Mastodon 4.6). */
export const ApiFeaturePolicy = z.object({
  automatic: z.array(z.literal(FEATURE_POLICIES)),
  manual: z.array(z.literal(FEATURE_POLICIES)),
  current_user: z.literal(USER_FEATURE_POLICIES),
});
export type ApiFeaturePolicyJSON = z.infer<typeof ApiFeaturePolicy>;

/**
 * `REST::AccountSerializer` (with `REST::MutedAccountSerializer`'s
 * `mute_expires_at`). `moved` is the account this one moved to.
 */
export const ApiAccount = z.object({
  id: z.string(),
  username: z.string(),
  acct: z.string(),
  url: z.string().nullable().optional(),
  uri: z.string(),
  display_name: z.string(),
  note: z.string(),
  avatar: z.string(),
  avatar_static: z.string(),
  header: z.string(),
  header_static: z.string(),
  /** Mastodon 4.6. */
  avatar_description: z.string(),
  /** Mastodon 4.6. */
  header_description: z.string(),
  locked: z.boolean(),
  fields: z.array(ApiAccountField),
  emojis: z.array(ApiCustomEmoji),
  bot: z.boolean(),
  group: z.boolean(),
  discoverable: z.boolean().nullable().optional(),
  indexable: z.boolean(),
  noindex: z.boolean().nullable().optional(),
  hide_collections: z.boolean().nullable(),
  /** Mastodon 4.6 profile tabs. */
  show_media: z.boolean(),
  show_media_replies: z.boolean(),
  show_featured: z.boolean(),
  feature_approval: ApiFeaturePolicy,
  suspended: z.boolean().optional(),
  limited: z.boolean().optional(),
  memorial: z.boolean().optional(),
  created_at: z.string(),
  last_status_at: z.string().nullable(),
  statuses_count: z.number(),
  followers_count: z.number(),
  following_count: z.number(),
  roles: z.array(ApiAccountRole).optional(),
  email_subscriptions: z.boolean().optional(),
  invalid_handle: z.boolean().optional(),
  /** `REST::MutedAccountSerializer` only. */
  mute_expires_at: z.string().nullable().optional(),
  get moved() {
    return ApiAccount.nullable().optional();
  },
});
export type ApiAccountJSON = z.infer<typeof ApiAccount>;
export type BaseApiAccountJSON = ApiAccountJSON;
export type ApiMutedAccountJSON = ApiAccountJSON;

/** `CredentialAccount#source` (`REST::CredentialAccountSerializer`). */
export const ApiAccountSource = z.object({
  privacy: z.literal(STATUS_VISIBILITIES),
  sensitive: z.boolean(),
  language: z.string().nullable(),
  note: z.string(),
  fields: z.array(ApiAccountField),
  follow_requests_count: z.number(),
  hide_collections: z.boolean().nullable(),
  discoverable: z.boolean().nullable(),
  indexable: z.boolean(),
  attribution_domains: z.array(z.string()),
  quote_policy: z.literal(QUOTE_POLICIES),
});
export type ApiAccountSourceJSON = z.infer<typeof ApiAccountSource>;

/** `CredentialAccount#role` (`REST::RoleSerializer`). */
export const ApiRole = z.object({
  id: z.string(),
  name: z.string(),
  permissions: z.string(),
  color: z.string(),
  highlighted: z.boolean(),
});
export type ApiRoleJSON = z.infer<typeof ApiRole>;

/** `REST::CredentialAccountSerializer`: the account with its `source` and `role`. */
export const ApiCredentialAccount = ApiAccount.extend({
  source: ApiAccountSource,
  role: ApiRole.optional(),
});
export type ApiCredentialAccountJSON = z.infer<typeof ApiCredentialAccount>;

/** `REST::FamiliarFollowersSerializer`. */
export const ApiFamiliarFollowers = z.array(
  z.object({ id: z.string(), accounts: z.array(ApiAccount) }),
);
export type ApiFamiliarFollowersJSON = z.infer<typeof ApiFamiliarFollowers>;
