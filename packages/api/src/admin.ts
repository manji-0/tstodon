import { z } from "zod";
import { ApiAccount, ApiRole } from "./account";
import { ApiAnnouncement } from "./announcement";
import { ApiCustomEmoji } from "./custom-emoji";
import { ApiRule } from "./instance";
import { ApiStatus } from "./status";
import { ApiHashtag, ApiTagHistory } from "./tag";
import {
  ADMIN_RETENTION_FREQUENCIES,
  DOMAIN_BLOCK_SEVERITIES,
  IP_BLOCK_SEVERITIES,
  REPORT_CATEGORIES,
} from "./values";

/*
 * The admin API (`/api/v1/admin/*`), as Mastodon's `REST::Admin::*`
 * serializers render it. The Mastodon web UI does not read these (its admin
 * pages are server-rendered); third-party moderation clients do.
 */

/** `REST::Admin::IpSerializer`. */
export const ApiAdminIp = z.object({ ip: z.string(), used_at: z.string() });
export type ApiAdminIpJSON = z.infer<typeof ApiAdminIp>;

/**
 * `REST::Admin::AccountSerializer`: the moderation view of an account, with
 * the public account nested as `account`. A remote account has no login, so
 * its `email`, `ip` and `locale` are `null`. `created_by_application_id` and
 * `invited_by_account_id` are present only when there is one.
 */
export const ApiAdminAccount = z.object({
  id: z.string(),
  username: z.string(),
  domain: z.string().nullable(),
  created_at: z.string(),
  email: z.string().nullable(),
  ip: z.string().nullable(),
  ips: z.array(ApiAdminIp),
  locale: z.string().nullable(),
  invite_request: z.string().nullable(),
  role: ApiRole,
  confirmed: z.boolean(),
  approved: z.boolean(),
  disabled: z.boolean(),
  silenced: z.boolean(),
  suspended: z.boolean(),
  sensitized: z.boolean(),
  /** tstodon: silenced or suspended, as `Account#limited`. */
  limited: z.boolean(),
  account: ApiAccount,
  created_by_application_id: z.string().optional(),
  invited_by_account_id: z.string().optional(),
});
export type ApiAdminAccountJSON = z.infer<typeof ApiAdminAccount>;

/**
 * `REST::Admin::ReportSerializer`. A party the report kept only by handle
 * (a remote actor purged from the cache) is shown from that handle; one it
 * kept nothing of is `null` (tstodon).
 */
export const ApiAdminReport = z.object({
  id: z.string(),
  action_taken: z.boolean(),
  action_taken_at: z.string().nullable(),
  category: z.literal(REPORT_CATEGORIES),
  comment: z.string(),
  forwarded: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  account: ApiAdminAccount.nullable(),
  target_account: ApiAdminAccount.nullable(),
  assigned_account: ApiAdminAccount.nullable(),
  action_taken_by_account: ApiAdminAccount.nullable(),
  statuses: z.array(ApiStatus),
  rules: z.array(ApiRule),
});
export type ApiAdminReportJSON = z.infer<typeof ApiAdminReport>;

/** `REST::Admin::DomainBlockSerializer`. */
export const ApiAdminDomainBlock = z.object({
  id: z.string(),
  domain: z.string(),
  /** Lowercase hex SHA-256 of `domain`. */
  digest: z.string(),
  created_at: z.string(),
  severity: z.literal(DOMAIN_BLOCK_SEVERITIES),
  reject_media: z.boolean(),
  reject_reports: z.boolean(),
  private_comment: z.string().nullable(),
  public_comment: z.string().nullable(),
  obfuscate: z.boolean(),
});
export type ApiAdminDomainBlockJSON = z.infer<typeof ApiAdminDomainBlock>;

/** `REST::Admin::DomainAllowSerializer`. */
export const ApiAdminDomainAllow = z.object({
  id: z.string(),
  domain: z.string(),
  created_at: z.string(),
});
export type ApiAdminDomainAllowJSON = z.infer<typeof ApiAdminDomainAllow>;

/**
 * `REST::Admin::EmailDomainBlockSerializer`: `history` counts the sign-ups
 * from the domain per day, newest first. tstodon does not count attempts
 * (`uses` is `"0"`) and has no sign-up-with-approval mode.
 */
export const ApiAdminEmailDomainBlock = z.object({
  id: z.string(),
  domain: z.string(),
  created_at: z.string(),
  history: z.array(ApiTagHistory),
  allow_with_approval: z.boolean(),
});
export type ApiAdminEmailDomainBlockJSON = z.infer<typeof ApiAdminEmailDomainBlock>;

/** `REST::Admin::CanonicalEmailBlockSerializer`. */
export const ApiAdminCanonicalEmailBlock = z.object({
  id: z.string(),
  canonical_email_hash: z.string(),
});
export type ApiAdminCanonicalEmailBlockJSON = z.infer<typeof ApiAdminCanonicalEmailBlock>;

/**
 * `REST::Admin::TagSerializer`: the hashtag with its review state. tstodon
 * names a tag by its name, so `id` is the name. `name` is the tag's
 * `display_name` when an admin set one (a different casing of the name).
 */
export const ApiAdminTag = ApiHashtag.extend({
  trendable: z.boolean(),
  usable: z.boolean(),
  requires_review: z.boolean(),
  listable: z.boolean(),
});
export type ApiAdminTagJSON = z.infer<typeof ApiAdminTag>;

/**
 * tstodon: `/api/v1/admin/announcements` (Mastodon manages announcements in
 * its admin pages only). The public announcement with the stored text, and
 * `published_at` `null` while it is a draft.
 */
export const ApiAdminAnnouncement = ApiAnnouncement.omit({ read: true }).extend({
  text: z.string(),
  published_at: z.string().nullable(),
  created_at: z.string(),
});
export type ApiAdminAnnouncementJSON = z.infer<typeof ApiAdminAnnouncement>;

/** tstodon: `/api/v1/admin/custom_emojis`, the custom emoji with its id. */
export const ApiAdminCustomEmoji = ApiCustomEmoji.extend({ id: z.string() });
export type ApiAdminCustomEmojiJSON = z.infer<typeof ApiAdminCustomEmoji>;

/**
 * `REST::Admin::IpBlockSerializer`. `ip` is the range in CIDR notation with
 * its prefix (`192.0.2.0/24`, a single address as `/32` or `/128`).
 */
export const ApiAdminIpBlock = z.object({
  id: z.string(),
  ip: z.string(),
  severity: z.literal(IP_BLOCK_SEVERITIES),
  comment: z.string(),
  created_at: z.string(),
  expires_at: z.string().nullable(),
});
export type ApiAdminIpBlockJSON = z.infer<typeof ApiAdminIpBlock>;

/** One day of a measure: `date` is midnight UTC, `value` a count as a string. */
export const ApiAdminMeasureData = z.object({ date: z.string(), value: z.string() });
export type ApiAdminMeasureDataJSON = z.infer<typeof ApiAdminMeasureData>;

/**
 * `REST::Admin::MeasureSerializer` (`POST /api/v1/admin/measures`). `total`
 * covers the requested range, and `previous_total` the range of the same
 * length before it, for measures counted in time (`active_users`,
 * `new_users`, ...); the `instance_*` measures total everything stored and
 * have no `previous_total`. `human_value` accompanies a `bytes` unit.
 */
export const ApiAdminMeasure = z.object({
  key: z.string(),
  unit: z.string().nullable(),
  total: z.string(),
  human_value: z.string().optional(),
  previous_total: z.string().optional(),
  data: z.array(ApiAdminMeasureData),
});
export type ApiAdminMeasureJSON = z.infer<typeof ApiAdminMeasure>;

/** One entry of a dimension, largest first. */
export const ApiAdminDimensionData = z.object({
  key: z.string(),
  human_key: z.string(),
  value: z.string(),
  unit: z.string().optional(),
  human_value: z.string().optional(),
});
export type ApiAdminDimensionDataJSON = z.infer<typeof ApiAdminDimensionData>;

/** `REST::Admin::DimensionSerializer` (`POST /api/v1/admin/dimensions`). */
export const ApiAdminDimension = z.object({
  key: z.string(),
  data: z.array(ApiAdminDimensionData),
});
export type ApiAdminDimensionJSON = z.infer<typeof ApiAdminDimension>;

/** One later period of a cohort: the share (`rate`, 0 to 1) and count still active. */
export const ApiAdminCohortData = z.object({
  date: z.string(),
  rate: z.number(),
  value: z.string(),
});
export type ApiAdminCohortDataJSON = z.infer<typeof ApiAdminCohortData>;

/**
 * `REST::Admin::CohortSerializer` (`POST /api/v1/admin/retention`): the
 * accounts that signed up in `period`, and how many of them were active in
 * each period since.
 */
export const ApiAdminCohort = z.object({
  period: z.string(),
  frequency: z.literal(ADMIN_RETENTION_FREQUENCIES),
  data: z.array(ApiAdminCohortData),
});
export type ApiAdminCohortJSON = z.infer<typeof ApiAdminCohort>;

/**
 * `REST::Admin::Trends::Links::PreviewCardProviderSerializer`
 * (`/api/v1/admin/trends/links/publishers`): a site whose links trend.
 * tstodon names a publisher by its domain, so `id` is the domain.
 */
export const ApiAdminPreviewCardProvider = z.object({
  id: z.string(),
  domain: z.string(),
  trendable: z.boolean(),
  reviewed_at: z.string().nullable(),
  requested_review_at: z.string().nullable(),
  requires_review: z.boolean(),
});
export type ApiAdminPreviewCardProviderJSON = z.infer<typeof ApiAdminPreviewCardProvider>;
