import { z } from "zod";
import { ApiAccount } from "./account";
import { ApiCollection } from "./collection";
import { ApiReport } from "./report";
import { ApiStatus } from "./status";
import {
  ACCOUNT_WARNING_ACTIONS,
  NOTIFICATION_WITH_STATUS_TYPES,
  SEVERANCE_EVENT_TYPES,
} from "./values";

/** `REST::AccountWarningSerializer`. */
export const ApiAccountWarning = z.object({
  id: z.string(),
  action: z.literal(ACCOUNT_WARNING_ACTIONS),
  text: z.string(),
  status_ids: z.array(z.string()).nullable(),
  created_at: z.string(),
  target_account: ApiAccount,
  appeal: z.unknown(),
});
export type ApiAccountWarningJSON = z.infer<typeof ApiAccountWarning>;

/** `REST::AccountRelationshipSeveranceEventSerializer`. */
export const ApiAccountRelationshipSeveranceEvent = z.object({
  id: z.string(),
  type: z.literal(SEVERANCE_EVENT_TYPES),
  purged: z.boolean(),
  target_name: z.string(),
  followers_count: z.number(),
  following_count: z.number(),
  created_at: z.string(),
});
export type ApiAccountRelationshipSeveranceEventJSON = z.infer<
  typeof ApiAccountRelationshipSeveranceEvent
>;

/** The `annual_report` payload of an `annual_report` notification. */
export const ApiAnnualReportEvent = z.object({ year: z.string() });
export type ApiAnnualReportEventJSON = z.infer<typeof ApiAnnualReportEvent>;

const notificationBase = {
  id: z.string(),
  created_at: z.string(),
  group_key: z.string(),
  account: ApiAccount,
};

/**
 * `REST::NotificationSerializer`, discriminated on Mastodon's `type`: each
 * type carries the payload Mastodon attaches to it.
 */
export const ApiNotification = z.discriminatedUnion("type", [
  z.object({
    ...notificationBase,
    type: z.literal(["follow", "follow_request", "admin.sign_up"]),
  }),
  z.object({
    ...notificationBase,
    type: z.literal(NOTIFICATION_WITH_STATUS_TYPES),
    status: ApiStatus.nullable(),
  }),
  z.object({ ...notificationBase, type: z.literal("admin.report"), report: ApiReport }),
  z.object({
    ...notificationBase,
    type: z.literal("severed_relationships"),
    event: ApiAccountRelationshipSeveranceEvent,
  }),
  z.object({
    ...notificationBase,
    type: z.literal("moderation_warning"),
    moderation_warning: ApiAccountWarning,
  }),
  z.object({
    ...notificationBase,
    type: z.literal("annual_report"),
    annual_report: ApiAnnualReportEvent,
  }),
  z.object({
    ...notificationBase,
    type: z.literal(["added_to_collection", "collection_update"]),
    collection: ApiCollection.nullable(),
  }),
  /** tstodon extension (Pleroma's shape): `target` is the account moved to. */
  z.object({ ...notificationBase, type: z.literal("move"), target: ApiAccount }),
]);
export type ApiNotificationJSON = z.infer<typeof ApiNotification>;
export type BaseNotificationJSON = ApiNotificationJSON;

const groupBase = {
  group_key: z.string(),
  notifications_count: z.number(),
  sample_account_ids: z.array(z.string()),
  most_recent_notification_id: z.string(),
  /** Only in a paginated list (`/api/v2/notifications`), not for one group. */
  latest_page_notification_at: z.string().optional(),
  page_min_id: z.string().optional(),
  page_max_id: z.string().optional(),
};

/** `REST::NotificationGroupSerializer`, discriminated on `type` as {@link ApiNotification}. */
export const ApiNotificationGroup = z.discriminatedUnion("type", [
  z.object({ ...groupBase, type: z.literal(["follow", "follow_request", "admin.sign_up"]) }),
  z.object({
    ...groupBase,
    type: z.literal(NOTIFICATION_WITH_STATUS_TYPES),
    status_id: z.string().nullable(),
  }),
  z.object({ ...groupBase, type: z.literal("admin.report"), report: ApiReport }),
  z.object({
    ...groupBase,
    type: z.literal("severed_relationships"),
    event: ApiAccountRelationshipSeveranceEvent,
  }),
  z.object({
    ...groupBase,
    type: z.literal("moderation_warning"),
    moderation_warning: ApiAccountWarning,
  }),
  z.object({
    ...groupBase,
    type: z.literal("annual_report"),
    annual_report: ApiAnnualReportEvent,
  }),
  z.object({
    ...groupBase,
    type: z.literal(["added_to_collection", "collection_update"]),
    collection: ApiCollection.nullable(),
  }),
  /** tstodon extension (see {@link ApiNotification}). */
  z.object({ ...groupBase, type: z.literal("move") }),
]);
export type ApiNotificationGroupJSON = z.infer<typeof ApiNotificationGroup>;
export type BaseNotificationGroupJSON = ApiNotificationGroupJSON;

/** `REST::DedupNotificationGroupSerializer`: `/api/v2/notifications`. */
export const ApiNotificationGroupsResult = z.object({
  accounts: z.array(ApiAccount),
  statuses: z.array(ApiStatus),
  notification_groups: z.array(ApiNotificationGroup),
});
export type ApiNotificationGroupsResultJSON = z.infer<typeof ApiNotificationGroupsResult>;

/** `REST::NotificationRequestSerializer`: `notifications_count` is a string. */
export const ApiNotificationRequest = z.object({
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  notifications_count: z.string(),
  account: ApiAccount,
  last_status: ApiStatus.nullable().optional(),
});
export type ApiNotificationRequestJSON = z.infer<typeof ApiNotificationRequest>;

/**
 * The notifications Mastodon defines: {@link ApiNotificationJSON} without
 * tstodon's `move` extension. The web UI handles these; a type it does not
 * know (such as `move` from the streaming API) it leaves unrendered.
 */
export type ApiMastodonNotificationJSON = Exclude<ApiNotificationJSON, { type: "move" }>;
/** {@link ApiNotificationGroupJSON} without tstodon's `move` extension. */
export type ApiMastodonNotificationGroupJSON = Exclude<ApiNotificationGroupJSON, { type: "move" }>;
/** {@link ApiNotificationGroupsResultJSON} with Mastodon's groups only. */
export type ApiMastodonNotificationGroupsResultJSON = Omit<
  ApiNotificationGroupsResultJSON,
  "notification_groups"
> & { notification_groups: ApiMastodonNotificationGroupJSON[] };
