import { createSelector } from '@reduxjs/toolkit';

import type { RootState } from 'mastodon/store';
import { immutableToJS } from 'mastodon/utils/immutable_map_of';

const selectNotificationSettings = (state: RootState) =>
  state.settings.get('notifications');

export const selectSettingsNotificationsShows = createSelector(
  [(state: RootState) => selectNotificationSettings(state).get('shows')],
  (shows) => immutableToJS(shows),
);

export const selectSettingsNotificationsExcludedTypes = createSelector(
  [(state: RootState) => selectNotificationSettings(state).get('shows')],
  (shows) => {
    const excludedTypes: string[] = [];
    shows.forEach((show, key) => {
      if (!show) {
        if (key === 'collections') {
          excludedTypes.push('collection_update', 'added_to_collection');
        } else {
          excludedTypes.push(key);
        }
      }
    });
    return excludedTypes;
  },
);

export const selectSettingsNotificationsQuickFilterShow = (state: RootState) =>
  selectNotificationSettings(state).get('quickFilter').get('show');

export const selectSettingsNotificationsQuickFilterActive = (
  state: RootState,
) => selectNotificationSettings(state).get('quickFilter').get('active');

export const selectSettingsNotificationsQuickFilterAdvanced = (
  state: RootState,
) => selectNotificationSettings(state).get('quickFilter').get('advanced');

export const selectSettingsNotificationsShowUnread = (state: RootState) =>
  selectNotificationSettings(state).get('showUnread');

export const selectNeedsNotificationPermission = (state: RootState) =>
  (selectNotificationSettings(state).get('alerts').includes(true) &&
    state.notifications.get('browserSupport') &&
    state.notifications.get('browserPermission') === 'default' &&
    !selectNotificationSettings(state).get('dismissPermissionBanner')) as boolean;

export const selectSettingsNotificationsMinimizeFilteredBanner = (
  state: RootState,
) => selectNotificationSettings(state).get('minimizeFilteredBanner');

export const selectSettingsNotificationsGroupFollows = (state: RootState) =>
  selectNotificationSettings(state).get('group').get('follow');
