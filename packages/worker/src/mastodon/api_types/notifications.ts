// See app/serializers/rest/notification_group_serializer.rb; the REST shapes
// live in @tstodon/api (packages/api), shared with the server.

import type {
  ApiMastodonNotificationGroupJSON,
  ApiMastodonNotificationGroupsResultJSON,
  ApiMastodonNotificationJSON,
  MastodonNotificationType,
} from '@tstodon/api';

export type {
  NotificationWithStatusType,
  ApiAccountWarningJSON,
  ApiAccountRelationshipSeveranceEventJSON,
  ApiAnnualReportEventJSON,
  ApiNotificationRequestJSON,
} from '@tstodon/api';

// Mastodon's notification types; tstodon's `move` extension (see
// packages/api/src/values.ts) is not among the types this UI renders.
export type NotificationType = MastodonNotificationType;
export type ApiNotificationJSON = ApiMastodonNotificationJSON;
export type BaseNotificationJSON = ApiNotificationJSON;
export type ApiNotificationGroupJSON = ApiMastodonNotificationGroupJSON;
export type BaseNotificationGroupJSON = ApiNotificationGroupJSON;
export type ApiNotificationGroupsResultJSON =
  ApiMastodonNotificationGroupsResultJSON;

// The types the web UI requests (see app/model/notification.rb).
export const allNotificationTypes: NotificationType[] = [
  'follow',
  'follow_request',
  'favourite',
  'reblog',
  'mention',
  'quote',
  'poll',
  'status',
  'update',
  'admin.sign_up',
  'admin.report',
  'moderation_warning',
  'severed_relationships',
  'annual_report',
  'added_to_collection',
  'collection_update',
];
