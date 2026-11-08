import { z } from "zod";
import { ApiAccount } from "./account";
import { TIMELINE_ACCESS_VALUES } from "./values";

/** `REST::RuleSerializer`. */
export const ApiRule = z.object({
  id: z.string(),
  text: z.string(),
  hint: z.string(),
  translations: z.record(z.string(), z.object({ text: z.string(), hint: z.string() })).optional(),
});
export type ApiRuleJSON = z.infer<typeof ApiRule>;

/** `/api/v1/instance/terms_of_service` (`REST::TermsOfServiceSerializer`). */
export const ApiTermsOfService = z.object({
  effective_date: z.string(),
  effective: z.boolean(),
  succeeded_by: z.string().nullable(),
  content: z.string(),
});
export type ApiTermsOfServiceJSON = z.infer<typeof ApiTermsOfService>;

/** `/api/v1/instance/privacy_policy`. */
export const ApiPrivacyPolicy = z.object({ updated_at: z.string(), content: z.string() });
export type ApiPrivacyPolicyJSON = z.infer<typeof ApiPrivacyPolicy>;

/** `/api/v1/instance/extended_description`. */
export const ApiExtendedDescription = z.object({
  updated_at: z.string().nullable(),
  content: z.string(),
});
export type ApiExtendedDescriptionJSON = z.infer<typeof ApiExtendedDescription>;

/** `/api/v1/instance/domain_blocks` (`REST::DomainBlockSerializer`). */
export const ApiDomainBlock = z.object({
  domain: z.string(),
  digest: z.string(),
  severity: z.literal(["silence", "suspend"]),
  comment: z.string().nullable().optional(),
});
export type ApiDomainBlockJSON = z.infer<typeof ApiDomainBlock>;

/** `/api/v1/instance/translation_languages`. */
export const ApiTranslationLanguages = z.record(z.string(), z.array(z.string()));
export type ApiTranslationLanguagesJSON = z.infer<typeof ApiTranslationLanguages>;

/** `/api/v1/instance/languages`. */
export const ApiInstanceLanguage = z.object({ code: z.string(), name: z.string() });
export type ApiInstanceLanguageJSON = z.infer<typeof ApiInstanceLanguage>;

const feedAccess = z.object({
  local: z.literal(TIMELINE_ACCESS_VALUES),
  remote: z.literal(TIMELINE_ACCESS_VALUES),
});

/** `REST::InstanceSerializer` (`/api/v2/instance`). */
export const ApiInstance = z.object({
  domain: z.string(),
  title: z.string(),
  version: z.string(),
  source_url: z.string(),
  description: z.string(),
  usage: z.object({ users: z.object({ active_month: z.number() }) }),
  thumbnail: z.object({
    url: z.string(),
    blurhash: z.string().optional(),
    description: z.string().optional(),
    versions: z.record(z.string(), z.string()).optional(),
  }),
  icon: z.array(z.object({ src: z.string(), size: z.string() })).optional(),
  languages: z.array(z.string()),
  configuration: z.object({
    urls: z.object({
      streaming: z.string(),
      status: z.string().nullable().optional(),
      about: z.string().nullable(),
      privacy_policy: z.string().nullable(),
      terms_of_service: z.string().nullable(),
    }),
    /** tstodon: `null` when no VAPID key is configured (no Web Push). */
    vapid: z.object({ public_key: z.string().nullable() }),
    accounts: z.object({
      max_display_name_length: z.number(),
      max_note_length: z.number(),
      max_avatar_description_length: z.number(),
      max_header_description_length: z.number(),
      max_featured_tags: z.number(),
      max_pinned_statuses: z.number(),
      max_profile_fields: z.number(),
      profile_field_name_limit: z.number(),
      profile_field_value_limit: z.number(),
    }),
    statuses: z.object({
      max_characters: z.number(),
      max_media_attachments: z.number(),
      characters_reserved_per_url: z.number(),
    }),
    media_attachments: z.object({
      description_limit: z.number(),
      image_matrix_limit: z.number(),
      image_size_limit: z.number(),
      supported_mime_types: z.array(z.string()),
      video_frame_rate_limit: z.number(),
      video_matrix_limit: z.number(),
      video_size_limit: z.number(),
    }),
    polls: z.object({
      max_options: z.number(),
      max_characters_per_option: z.number(),
      min_expiration: z.number(),
      max_expiration: z.number(),
    }),
    translation: z.object({ enabled: z.boolean() }),
    /** Mastodon 4.5. */
    timeline_access: z.object({
      live_feeds: feedAccess,
      hashtag_feeds: feedAccess,
      trending_link_feeds: feedAccess,
    }),
    limited_federation: z.boolean(),
  }),
  registrations: z.object({
    enabled: z.boolean(),
    approval_required: z.boolean(),
    reason_required: z.boolean().nullable(),
    message: z.string().nullable(),
    min_age: z.number().nullable(),
    url: z.string().nullable(),
  }),
  api_versions: z.object({ mastodon: z.number() }),
  contact: z.object({
    email: z.string().nullable(),
    account: ApiAccount.nullable(),
  }),
  rules: z.array(ApiRule),
});
export type ApiInstanceJSON = z.infer<typeof ApiInstance>;
