import { z } from "zod";
import { NOTIFICATION_POLICY_VALUES } from "./values";

const value = z.literal(NOTIFICATION_POLICY_VALUES);

/** `REST::NotificationPolicySerializer` (v2). */
export const ApiNotificationPolicy = z.object({
  for_not_following: value,
  for_not_followers: value,
  for_new_accounts: value,
  for_private_mentions: value,
  for_limited_accounts: value,
  /** Mastodon 4.6. */
  for_bots: value,
  summary: z.object({
    pending_requests_count: z.number(),
    pending_notifications_count: z.number(),
  }),
});
export type NotificationPolicyJSON = z.infer<typeof ApiNotificationPolicy>;
