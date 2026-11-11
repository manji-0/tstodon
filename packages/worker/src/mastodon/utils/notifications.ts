/**
 * Tries Notification.requestPermission, console warning instead of rejecting on error.
 * @param callback Runs with the permission result on completion.
 */
export const requestNotificationPermission = async (
  callback: NotificationPermissionCallback,
) => {
  try {
    callback(await Notification.requestPermission());
  } catch (error) {
    console.warn(error);
  }
};

/**
 * The notification types the settings toggle (`settings.notifications`'s
 * `alerts`, `shows` and `sounds`): one key covers both collection types.
 */
export const NOTIFICATION_SETTING_KEYS = [
  'follow',
  'follow_request',
  'favourite',
  'reblog',
  'quote',
  'mention',
  'poll',
  'status',
  'update',
  'collections',
  'admin.sign_up',
  'admin.report',
] as const;

export type NotificationSettingKey = (typeof NOTIFICATION_SETTING_KEYS)[number];

/**
 * The settings key that toggles a notification type, or `undefined` for the
 * types no setting turns off (`moderation_warning`, `severed_relationships`,
 * `annual_report`, `move`).
 */
export const notificationSettingKey = (
  type: string,
): NotificationSettingKey | undefined => {
  switch (type) {
    case 'quoted_update':
      return 'update';
    case 'added_to_collection':
    case 'collection_update':
      return 'collections';
    default:
      return NOTIFICATION_SETTING_KEYS.find((key) => key === type);
  }
};
