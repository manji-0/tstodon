import { IntlMessageFormat } from 'intl-messageformat';
import { defineMessages } from 'react-intl';

import type { ApiNotificationJSON } from 'mastodon/api_types/notifications';
import type { AppDispatch, GetState } from 'mastodon/store';

import { unescapeHTML } from '../utils/html';
import { notificationSettingKey, requestNotificationPermission } from '../utils/notifications';

import { fetchFollowRequests } from './accounts';
import {
  importFetchedAccount,
} from './importer';
import { submitMarkers } from './markers';
import { notificationsUpdate } from "./notifications_typed";
import { register as registerPushNotifications } from './push_notifications';

export * from "./notifications_typed";

export const NOTIFICATIONS_FILTER_SET = 'NOTIFICATIONS_FILTER_SET';

export const NOTIFICATIONS_SET_BROWSER_SUPPORT    = 'NOTIFICATIONS_SET_BROWSER_SUPPORT' as const;
export const NOTIFICATIONS_SET_BROWSER_PERMISSION = 'NOTIFICATIONS_SET_BROWSER_PERMISSION' as const;

defineMessages({
  mention: { id: 'notification.mention', defaultMessage: '{name} mentioned you' },
  group: { id: 'notifications.group', defaultMessage: '{count} notifications' },
});

export function updateNotifications(
  notification: ApiNotificationJSON,
  intlMessages: Record<string, string>,
  intlLocale: string | undefined,
) {
  return (dispatch: AppDispatch, getState: GetState) => {
    // The types no setting turns off alert and sound. Upstream looked the
    // setting up by type, so the collection types (both under
    // `collections`) ignored theirs.
    const settingKey   = notificationSettingKey(notification.type);
    const settings     = getState().settings.get('notifications');
    const showAlert    = settingKey === undefined || settings.get('alerts').get(settingKey, true);
    const playSound    = settingKey === undefined || settings.get('sounds').get(settingKey, true);
    const status       = 'status' in notification ? notification.status : null;

    let filtered = false;

    if (['mention', 'quote', 'status'].includes(notification.type) && status?.filtered) {
      const filters = status.filtered.filter(result => result.filter.context.includes('notifications'));

      if (filters.some(result => result.filter.filter_action === 'hide')) {
        return;
      }

      filtered = filters.length > 0;
    }

    if (['follow_request'].includes(notification.type)) {
      dispatch(fetchFollowRequests());
    }

    void dispatch(submitMarkers({}));

    // `notificationsUpdate` is still used in `user_lists` and `relationships` reducers
    dispatch(importFetchedAccount(notification.account));
    dispatch(notificationsUpdate({ notification, playSound: !!playSound && !filtered}));

    // Desktop notifications, for the types with a title message (not, for
    // example, `severed_relationships` or `annual_report`).
    const titleMessage = intlMessages[`notification.${notification.type}`];

    if (typeof window.Notification !== 'undefined' && showAlert && !filtered && titleMessage) {
      const title = new IntlMessageFormat(titleMessage, intlLocale).format({ name: notification.account.display_name.length > 0 ? notification.account.display_name : notification.account.username });
      const body  = (status && status.spoiler_text.length > 0) ? status.spoiler_text : unescapeHTML(status ? status.content : '');

      const notify = new Notification(typeof title === 'string' ? title : String(title), { body, icon: notification.account.avatar, tag: notification.id });

      notify.addEventListener('click', () => {
        window.focus();
        notify.close();
      });
    }
  };
}

const noOp = () => {};

// Browser support
export function setupBrowserNotifications() {
  return (dispatch: AppDispatch) => {
    dispatch(setBrowserSupport('Notification' in window));
    if ('Notification' in window) {
      dispatch(setBrowserPermission(Notification.permission));
    }

    if ('Notification' in window && 'permissions' in navigator) {
      navigator.permissions.query({ name: 'notifications' }).then((status) => {
        status.onchange = () => dispatch(setBrowserPermission(Notification.permission));
      }).catch(console.warn);
    }
  };
}

export function requestBrowserPermission(
  callback: (permission: NotificationPermission) => void = noOp,
) {
  return (dispatch: AppDispatch) => {
    void requestNotificationPermission((permission) => {
      dispatch(setBrowserPermission(permission));
      callback(permission);

      if (permission === 'granted') {
        dispatch(registerPushNotifications());
      }
    });
  };
}

export function setBrowserSupport (value: boolean) {
  return {
    type: NOTIFICATIONS_SET_BROWSER_SUPPORT,
    value,
  };
}

export function setBrowserPermission (value: NotificationPermission) {
  return {
    type: NOTIFICATIONS_SET_BROWSER_PERMISSION,
    value,
  };
}
