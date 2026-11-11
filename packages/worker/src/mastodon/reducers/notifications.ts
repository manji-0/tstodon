import { createReducer } from '@reduxjs/toolkit';
import { fromJS } from 'immutable';
import type { Map as ImmutableMap } from 'immutable';

import type {
  ApiNotificationJSON,
  NotificationType,
} from 'mastodon/api_types/notifications';

import {
  NOTIFICATIONS_SET_BROWSER_SUPPORT,
  NOTIFICATIONS_SET_BROWSER_PERMISSION,
} from '../actions/notifications';
import type {
  setBrowserPermission,
  setBrowserSupport,
} from '../actions/notifications';

import { immutableMapOf } from '../utils/immutable_map_of';
import type { ImmutableMapOf } from '../utils/immutable_map_of';

import { matchAction } from './match_action';

/** Whether the browser has desktop notifications, and their permission. */
export interface NotificationsFields {
  browserSupport: boolean;
  browserPermission: NotificationPermission;
}

export type NotificationsState = ImmutableMapOf<NotificationsFields>;

/**
 * A notification as `notificationToMap` stores it (the notification
 * request's notifications): the account and status by id.
 */
export interface NotificationMapFields {
  id: string;
  type: NotificationType;
  account: string;
  created_at: string;
  status: string | null;
  report: ImmutableMap<string, unknown> | null;
  event: ImmutableMap<string, unknown> | null;
  moderation_warning: ImmutableMap<string, unknown> | null;
}

export type NotificationMap = ImmutableMapOf<NotificationMapFields>;

const initialState: NotificationsState = immutableMapOf<NotificationsFields>({
  browserSupport: false,
  browserPermission: 'default',
});

export const notificationToMap = (
  notification: ApiNotificationJSON,
): NotificationMap =>
  immutableMapOf<NotificationMapFields>({
    id: notification.id,
    type: notification.type,
    account: notification.account.id,
    created_at: notification.created_at,
    status:
      'status' in notification && notification.status
        ? notification.status.id
        : null,
    report:
      'report' in notification && notification.report
        ? fromJS(notification.report)
        : null,
    event:
      'event' in notification && notification.event
        ? fromJS(notification.event)
        : null,
    moderation_warning:
      'moderation_warning' in notification && notification.moderation_warning
        ? fromJS(notification.moderation_warning)
        : null,
  });

const isSetBrowserSupport = matchAction<ReturnType<typeof setBrowserSupport>>(
  NOTIFICATIONS_SET_BROWSER_SUPPORT,
);
const isSetBrowserPermission = matchAction<
  ReturnType<typeof setBrowserPermission>
>(NOTIFICATIONS_SET_BROWSER_PERMISSION);

const notificationsReducer = createReducer(initialState, (builder) => {
  builder
    .addMatcher(isSetBrowserSupport, (state, action) =>
      state.set('browserSupport', action.value),
    )
    .addMatcher(isSetBrowserPermission, (state, action) =>
      state.set('browserPermission', action.value),
    );
});

export default notificationsReducer;
