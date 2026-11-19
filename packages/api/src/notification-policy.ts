import { z } from "zod";
import { NOTIFICATION_POLICY_VALUES } from "./values";

const value = z.literal(NOTIFICATION_POLICY_VALUES);

const summary = z.object({
  pending_requests_count: z.number(),
  pending_notifications_count: z.number(),
});

/** `REST::NotificationPolicySerializer` (v2). */
export const ApiNotificationPolicy = z.object({
  for_not_following: value,
  for_not_followers: value,
  for_new_accounts: value,
  for_private_mentions: value,
  for_limited_accounts: value,
  /** Mastodon 4.6. */
  for_bots: value,
  summary,
});
export type NotificationPolicyJSON = z.infer<typeof ApiNotificationPolicy>;

/**
 * `REST::V1::NotificationPolicySerializer`: each `filter_*` is whether that
 * `for_*` is anything but `accept` (`filter` or `drop`).
 */
export const ApiNotificationPolicyV1 = z.object({
  filter_not_following: z.boolean(),
  filter_not_followers: z.boolean(),
  filter_new_accounts: z.boolean(),
  filter_private_mentions: z.boolean(),
  filter_bots: z.boolean(),
  summary,
});
export type NotificationPolicyV1JSON = z.infer<typeof ApiNotificationPolicyV1>;
