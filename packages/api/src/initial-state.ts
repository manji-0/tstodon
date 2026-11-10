import { z } from "zod";
import { ApiAccount, ApiRole } from "./account";
import {
  ANNUAL_REPORT_STATES,
  DISPLAY_MEDIA_VALUES,
  EMOJI_STYLES,
  LANDING_PAGES,
  LOCAL_TOPIC_FEED_ACCESS_VALUES,
  QUOTE_POLICIES,
  STATUS_VISIBILITIES,
  TIMELINE_ACCESS_VALUES,
} from "./values";

/**
 * The web UI's boot document: the JSON in the shell's
 * `<script id="initial-state">`, as Mastodon's `InitialStateSerializer`
 * renders it (`app/serializers/initial_state_serializer.rb`, from
 * `InitialStatePresenter`). It is not an API response, but the server builds
 * it and the UI reads it (`src/mastodon/initial_state.ts`, the store's
 * hydration), so its shape is shared the same way.
 */

/** `languages`: `[code, English name, native name]`, from `LanguagesHelper::SUPPORTED_LOCALES`. */
export const ApiInitialStateLanguage = z.tuple([z.string(), z.string(), z.string()]);
export type ApiInitialStateLanguageJSON = z.infer<typeof ApiInitialStateLanguage>;

/** `meta.wrapstodon`: the viewer's annual report, while one is offered. */
export const ApiWrapstodon = z.object({
  year: z.number(),
  state: z.literal(ANNUAL_REPORT_STATES),
});
export type ApiWrapstodonJSON = z.infer<typeof ApiWrapstodon>;

/**
 * `meta`. Mastodon renders the server-wide keys for everyone, the viewer's
 * preferences only when signed in (where it renders the instance defaults of
 * `auto_play_gif`, `display_media`, `reduce_motion` and `use_blurhash` for a
 * visitor), and `disabled_account_id`, `moved_to_account_id` and `owner`
 * only when they apply.
 */
export const ApiInitialStateMeta = z.object({
  access_token: z.string().nullable(),
  activity_api_enabled: z.boolean(),
  /** The site contact account's id (`Setting.site_contact_username`), not the viewer's. */
  admin: z.string().nullable(),
  domain: z.string(),
  limited_federation_mode: z.boolean(),
  locale: z.string(),
  mascot: z.string().nullable(),
  profile_directory: z.boolean(),
  registrations_open: z.boolean(),
  repository: z.string(),
  search_enabled: z.boolean(),
  single_user_mode: z.boolean(),
  source_url: z.string(),
  /** The single sign-on provider's path when it is the only way in, else `null`. */
  sso_redirect: z.string().nullable(),
  status_page_url: z.string().nullable(),
  streaming_api_base_url: z.string(),
  title: z.string(),
  landing_page: z.literal(LANDING_PAGES),
  trends_enabled: z.boolean(),
  version: z.string(),
  terms_of_service_enabled: z.boolean(),
  /** Mastodon 4.5's feed access settings (`instance.configuration.timeline_access`). */
  local_live_feed_access: z.literal(TIMELINE_ACCESS_VALUES),
  remote_live_feed_access: z.literal(TIMELINE_ACCESS_VALUES),
  local_topic_feed_access: z.literal(LOCAL_TOPIC_FEED_ACCESS_VALUES),
  remote_topic_feed_access: z.literal(TIMELINE_ACCESS_VALUES),
  auto_play_gif: z.boolean(),
  display_media: z.literal(DISPLAY_MEDIA_VALUES),
  reduce_motion: z.boolean(),
  use_blurhash: z.boolean(),
  /** Signed in only. */
  me: z.string().optional(),
  boost_modal: z.boolean().optional(),
  quick_boosting: z.boolean().optional(),
  delete_modal: z.boolean().optional(),
  missing_alt_text_modal: z.boolean().optional(),
  expand_spoilers: z.boolean().optional(),
  disable_swiping: z.boolean().optional(),
  disable_hover_cards: z.boolean().optional(),
  advanced_layout: z.boolean().optional(),
  use_pending_items: z.boolean().optional(),
  show_trends: z.boolean().optional(),
  emoji_style: z.literal(EMOJI_STYLES).optional(),
  wrapstodon: ApiWrapstodon.nullable().optional(),
  /** The viewer's account when its login is disabled. */
  disabled_account_id: z.string().optional(),
  /** The account the viewer's account moved to. */
  moved_to_account_id: z.string().optional(),
  /** Single-user mode's owner. */
  owner: z.string().optional(),
});
export type ApiInitialStateMetaJSON = z.infer<typeof ApiInitialStateMeta>;

/** `compose`: the viewer's posting defaults (signed in), and `text` from a share link. */
export const ApiInitialStateCompose = z.object({
  me: z.string().optional(),
  default_privacy: z.literal(STATUS_VISIBILITIES).optional(),
  default_sensitive: z.boolean().optional(),
  default_language: z.string().optional(),
  default_quote_policy: z.literal(QUOTE_POLICIES).optional(),
  text: z.string().optional(),
});
export type ApiInitialStateComposeJSON = z.infer<typeof ApiInitialStateCompose>;

/**
 * `role` (`REST::RoleSerializer`), signed in only. Mastodon 4.6 adds the
 * role's `collection_limit` (how many collections the viewer may create);
 * tstodon has no collections and leaves it out, which the UI reads as 0.
 */
export const ApiInitialStateRole = ApiRole.extend({
  collection_limit: z.number().optional(),
});
export type ApiInitialStateRoleJSON = z.infer<typeof ApiInitialStateRole>;

/** `push_subscription` (`REST::WebPushSubscriptionSerializer`): the session's Web Push subscription. */
export const ApiWebPushSubscription = z.object({
  id: z.number(),
  endpoint: z.string(),
  standard: z.boolean(),
  alerts: z.record(z.string(), z.boolean()),
  policy: z.string(),
  server_key: z.string(),
});
export type ApiWebPushSubscriptionJSON = z.infer<typeof ApiWebPushSubscription>;

/**
 * `settings`: the web UI's own settings (`Web::Setting#data`, `PUT
 * /api/web/settings`), an object only the UI interprets (column layout,
 * notification filters, ...). The server stores and returns it as it is.
 */
export const ApiWebSettings = z.record(z.string(), z.unknown());
export type ApiWebSettingsJSON = z.infer<typeof ApiWebSettings>;

export const ApiInitialState = z.object({
  meta: ApiInitialStateMeta,
  compose: ApiInitialStateCompose,
  /** The viewer's credential account, and the accounts `meta` names (keyed by id). */
  accounts: z.record(z.string(), ApiAccount),
  media_attachments: z.object({ accept_content_types: z.array(z.string()) }),
  settings: ApiWebSettings,
  languages: z.array(ApiInitialStateLanguage),
  features: z.array(z.string()),
  push_subscription: ApiWebPushSubscription.nullable(),
  role: ApiInitialStateRole.optional(),
  /** Mastodon: for a viewer who may see the software updates, when one is critical. */
  critical_updates_pending: z.boolean().optional(),
});
export type ApiInitialStateJSON = z.infer<typeof ApiInitialState>;
