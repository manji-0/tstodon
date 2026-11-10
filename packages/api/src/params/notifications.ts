import { z } from "zod";
import { ApiPaginationParamsSchema } from "./pagination";

/**
 * `GET /api/v1/notifications`. Notification types are strings: an unknown
 * one matches nothing rather than failing the request.
 */
export const ApiGetNotificationsParamsSchema = ApiPaginationParamsSchema.extend({
  types: z.array(z.string()).optional(),
  exclude_types: z.array(z.string()).optional(),
  account_id: z.string().optional(),
  include_filtered: z.boolean().optional(),
});
export type ApiGetNotificationsParams = z.input<typeof ApiGetNotificationsParamsSchema>;

/** `GET /api/v2/notifications` (and its `unread_count`). */
export const ApiGetGroupedNotificationsParamsSchema = ApiGetNotificationsParamsSchema.extend({
  grouped_types: z.array(z.string()).optional(),
});
export type ApiGetGroupedNotificationsParams = z.input<
  typeof ApiGetGroupedNotificationsParamsSchema
>;

/** `GET /api/v1/notifications/requests`. */
export const ApiGetNotificationRequestsParamsSchema = ApiPaginationParamsSchema;
export type ApiGetNotificationRequestsParams = z.input<
  typeof ApiGetNotificationRequestsParamsSchema
>;

/** `POST /api/v1/notifications/requests/accept` and `/dismiss`. */
export const ApiNotificationRequestIdsParamsSchema = z.object({
  id: z.array(z.string()).optional(),
});
export type ApiNotificationRequestIdsParams = z.input<typeof ApiNotificationRequestIdsParamsSchema>;

/**
 * `PUT` / `PATCH /api/v2/notifications/policy`. Each `for_*` is `accept`,
 * `filter` or `drop`; the server reads it case-insensitively and keeps the
 * stored value for anything else, so it is a string here. The `filter_*`
 * booleans are v1's names, still read when the matching `for_*` is absent.
 */
export const ApiUpdateNotificationPolicyParamsSchema = z.object({
  for_not_following: z.string().optional(),
  for_not_followers: z.string().optional(),
  for_new_accounts: z.string().optional(),
  for_private_mentions: z.string().optional(),
  for_limited_accounts: z.string().optional(),
  for_bots: z.string().optional(),
  filter_not_following: z.boolean().optional(),
  filter_not_followers: z.boolean().optional(),
  filter_new_accounts: z.boolean().optional(),
  filter_private_mentions: z.boolean().optional(),
  filter_limited_accounts: z.boolean().optional(),
});
export type ApiUpdateNotificationPolicyParams = z.input<
  typeof ApiUpdateNotificationPolicyParamsSchema
>;
