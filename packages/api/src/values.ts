/**
 * The enum-like strings of Mastodon's REST API, as plain constant arrays.
 *
 * This module imports nothing, so the web client can import a value from it
 * (`@tstodon/api/values`) without pulling Zod into its bundle. The schemas in
 * this package build their `z.literal` unions from these arrays, so each list
 * is written once for the server and the client.
 */

const includes = <T extends string>(values: ReadonlyArray<T>, value: string): value is T =>
  values.some((candidate) => candidate === value);

/**
 * `Status#visibility` as the API renders it. Mastodon's internal `limited`
 * never reaches the API (it renders as `private`).
 */
export const STATUS_VISIBILITIES = ["public", "unlisted", "private", "direct"] as const;
export type StatusVisibility = (typeof STATUS_VISIBILITIES)[number];
export const isStatusVisibility = (value: string): value is StatusVisibility =>
  includes(STATUS_VISIBILITIES, value);

/**
 * The quote policy an author picks (`quote_approval_policy` on a status,
 * `source.quote_policy` on the credential account).
 */
export const QUOTE_POLICIES = ["public", "followers", "nobody"] as const;
export type QuotePolicyName = (typeof QUOTE_POLICIES)[number];
export const isQuotePolicyName = (value: string): value is QuotePolicyName =>
  includes(QUOTE_POLICIES, value);

/**
 * The audiences in `quote_approval.automatic` / `manual`
 * (`REST::StatusSerializer#quote_approval`); `unsupported_policy` stands for a
 * remote policy this server cannot express.
 */
export const QUOTE_APPROVAL_AUDIENCES = [
  "public",
  "followers",
  "following",
  "unsupported_policy",
] as const;
export type QuoteApprovalAudience = (typeof QUOTE_APPROVAL_AUDIENCES)[number];

/** `quote_approval.current_user`: whether the viewer may quote the status. */
export const USER_QUOTE_POLICIES = ["automatic", "manual", "denied", "unknown"] as const;
export type UserQuotePolicy = (typeof USER_QUOTE_POLICIES)[number];

/**
 * `Quote#state` (`REST::BaseQuoteSerializer`), with the states
 * `StatusFilter#filter_state_for_quote` substitutes for an accepted quote.
 */
export const QUOTE_STATES = [
  "pending",
  "accepted",
  "rejected",
  "revoked",
  "deleted",
  "unauthorized",
  "blocked_account",
  "blocked_domain",
  "muted_account",
] as const;
export type QuoteState = (typeof QUOTE_STATES)[number];

/** Account `feature_approval` audiences (Mastodon 4.6). */
export const FEATURE_POLICIES = [
  "public",
  "followers",
  "following",
  "disabled",
  "unsupported_policy",
] as const;
export type FeaturePolicy = (typeof FEATURE_POLICIES)[number];

/** `feature_approval.current_user` (Mastodon 4.6). */
export const USER_FEATURE_POLICIES = [
  "automatic",
  "manual",
  "denied",
  "missing",
  "unknown",
] as const;
export type UserFeaturePolicy = (typeof USER_FEATURE_POLICIES)[number];

/** `MediaAttachment#type`. */
export const MEDIA_ATTACHMENT_TYPES = ["unknown", "image", "gifv", "video", "audio"] as const;
export type MediaAttachmentType = (typeof MEDIA_ATTACHMENT_TYPES)[number];

/** `PreviewCard#type`. */
export const PREVIEW_CARD_TYPES = ["link", "photo", "video", "rich"] as const;
export type PreviewCardType = (typeof PREVIEW_CARD_TYPES)[number];
export const isPreviewCardType = (value: string): value is PreviewCardType =>
  includes(PREVIEW_CARD_TYPES, value);

/** Mastodon's `Notification::TYPES`, with Mastodon 4.7's collection notifications. */
export const NOTIFICATION_TYPES = [
  "mention",
  "status",
  "reblog",
  "follow",
  "follow_request",
  "favourite",
  "poll",
  "update",
  "admin.sign_up",
  "admin.report",
  "severed_relationships",
  "moderation_warning",
  "annual_report",
  "quote",
  "quoted_update",
  "added_to_collection",
  "collection_update",
] as const;

/**
 * Notification types tstodon renders beyond Mastodon's: `move` (an account
 * the viewer follows moved; the new account is `target`), as Pleroma and
 * Akkoma render it. Mastodon's web UI does not request it.
 */
export const EXTENSION_NOTIFICATION_TYPES = ["move"] as const;

export type MastodonNotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotificationType =
  | MastodonNotificationType
  | (typeof EXTENSION_NOTIFICATION_TYPES)[number];
export const isNotificationType = (value: string): value is NotificationType =>
  includes(NOTIFICATION_TYPES, value) || includes(EXTENSION_NOTIFICATION_TYPES, value);

/** The notification types that carry a `status`. */
export const NOTIFICATION_WITH_STATUS_TYPES = [
  "favourite",
  "reblog",
  "status",
  "mention",
  "quote",
  "poll",
  "update",
  "quoted_update",
] as const;
export type NotificationWithStatusType = (typeof NOTIFICATION_WITH_STATUS_TYPES)[number];
export const isNotificationWithStatusType = (value: string): value is NotificationWithStatusType =>
  includes(NOTIFICATION_WITH_STATUS_TYPES, value);

/** `AccountRelationshipSeveranceEvent#type`. */
export const SEVERANCE_EVENT_TYPES = [
  "domain_block",
  "user_domain_block",
  "account_suspension",
] as const;
export type SeveranceEventType = (typeof SEVERANCE_EVENT_TYPES)[number];

/** `AccountWarning#action`. */
export const ACCOUNT_WARNING_ACTIONS = [
  "none",
  "disable",
  "mark_statuses_as_sensitive",
  "delete_statuses",
  "sensitive",
  "silence",
  "suspend",
] as const;
export type AccountWarningAction = (typeof ACCOUNT_WARNING_ACTIONS)[number];

/** `Filter#context`. */
export const FILTER_CONTEXTS = ["home", "notifications", "public", "thread", "account"] as const;
export type FilterContext = (typeof FILTER_CONTEXTS)[number];
export const isFilterContext = (value: string): value is FilterContext =>
  includes(FILTER_CONTEXTS, value);

/** `Filter#filter_action` (`blur` since Mastodon 4.4). */
export const FILTER_ACTIONS = ["warn", "hide", "blur"] as const;
export type FilterAction = (typeof FILTER_ACTIONS)[number];

/** `Report#category`. */
export const REPORT_CATEGORIES = ["other", "spam", "legal", "violation"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export const isReportCategory = (value: string): value is ReportCategory =>
  includes(REPORT_CATEGORIES, value);

/** `List#replies_policy`. */
export const LIST_REPLIES_POLICIES = ["followed", "list", "none"] as const;
export type RepliesPolicyType = (typeof LIST_REPLIES_POLICIES)[number];

/** `NotificationPolicy` `for_*` values. */
export const NOTIFICATION_POLICY_VALUES = ["accept", "filter", "drop"] as const;
export type NotificationPolicyValue = (typeof NOTIFICATION_POLICY_VALUES)[number];

/** `Suggestion#sources`. */
export const SUGGESTION_SOURCES = [
  "featured",
  "most_followed",
  "most_interactions",
  "similar_to_recently_followed",
  "friends_of_friends",
] as const;
export type ApiSuggestionSourceJSON = (typeof SUGGESTION_SOURCES)[number];

/** `instance.configuration.timeline_access` values (Mastodon 4.5). */
export const TIMELINE_ACCESS_VALUES = ["public", "authenticated", "disabled"] as const;
export type TimelineAccess = (typeof TIMELINE_ACCESS_VALUES)[number];

/** `Marker` timelines. */
export const MARKER_TIMELINES = ["home", "notifications"] as const;
export type MarkerTimeline = (typeof MARKER_TIMELINES)[number];

/** `Admin::DomainBlock#severity`; the public `DomainBlock` leaves `noop` out. */
export const DOMAIN_BLOCK_SEVERITIES = ["silence", "suspend", "noop"] as const;
export type DomainBlockSeverity = (typeof DOMAIN_BLOCK_SEVERITIES)[number];

/** `IpBlock#severity` (`/api/v1/admin/ip_blocks`). */
export const IP_BLOCK_SEVERITIES = [
  "sign_up_requires_approval",
  "sign_up_block",
  "no_access",
] as const;
export type IpBlockSeverity = (typeof IP_BLOCK_SEVERITIES)[number];
export const isIpBlockSeverity = (value: string): value is IpBlockSeverity =>
  includes(IP_BLOCK_SEVERITIES, value);

/** `Admin::Metrics::Measure::MEASURES` keys (`POST /api/v1/admin/measures`). */
export const ADMIN_MEASURE_KEYS = [
  "active_users",
  "new_users",
  "interactions",
  "opened_reports",
  "resolved_reports",
  "tag_accounts",
  "tag_uses",
  "tag_servers",
  "instance_accounts",
  "instance_media_attachments",
  "instance_reports",
  "instance_statuses",
  "instance_follows",
  "instance_followers",
] as const;
export type AdminMeasureKey = (typeof ADMIN_MEASURE_KEYS)[number];
export const isAdminMeasureKey = (value: string): value is AdminMeasureKey =>
  includes(ADMIN_MEASURE_KEYS, value);

/** `Admin::Metrics::Dimension::DIMENSIONS` keys (`POST /api/v1/admin/dimensions`). */
export const ADMIN_DIMENSION_KEYS = [
  "languages",
  "sources",
  "servers",
  "space_usage",
  "software_versions",
  "tag_servers",
  "tag_languages",
  "instance_accounts",
  "instance_languages",
] as const;
export type AdminDimensionKey = (typeof ADMIN_DIMENSION_KEYS)[number];
export const isAdminDimensionKey = (value: string): value is AdminDimensionKey =>
  includes(ADMIN_DIMENSION_KEYS, value);

/** `Admin::Metrics::Retention` frequencies (`POST /api/v1/admin/retention`). */
export const ADMIN_RETENTION_FREQUENCIES = ["day", "month"] as const;
export type AdminRetentionFrequency = (typeof ADMIN_RETENTION_FREQUENCIES)[number];
export const isAdminRetentionFrequency = (value: string): value is AdminRetentionFrequency =>
  includes(ADMIN_RETENTION_FREQUENCIES, value);
