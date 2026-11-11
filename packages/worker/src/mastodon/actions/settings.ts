import { debounce } from 'lodash';

import { apiUpdateWebSettings } from 'mastodon/api/web_settings';
import type { AppDispatch, GetState } from 'mastodon/store';

import { showAlertForError } from './alerts';

export const SETTING_CHANGE = 'SETTING_CHANGE' as const;
export const SETTING_SAVE   = 'SETTING_SAVE' as const;

/** A path in the settings (`['notifications', 'alerts', 'follow']`). */
export type SettingPath = readonly (string | number)[];

/**
 * `SETTING_CHANGE`: sets `value` at `path` in the settings. The notification
 * filter bar sends the same with its own type (`NOTIFICATIONS_FILTER_SET`).
 */
export type SettingChangeAction<Type extends string = typeof SETTING_CHANGE> = {
  type: Type;
  path: SettingPath;
  value: unknown;
};

export type SettingSaveAction = {
  type: typeof SETTING_SAVE;
};

export function changeSetting(path: SettingPath, value: unknown) {
  return (dispatch: AppDispatch) => {
    dispatch({
      type: SETTING_CHANGE,
      path,
      value,
    } satisfies SettingChangeAction);

    dispatch(saveSettings());
  };
}

const debouncedSave = debounce((dispatch: AppDispatch, getState: GetState) => {
  if (getState().settings.get('saved') || !getState().meta.get('me')) {
    return;
  }

  const data = getState().settings.filter((_, path) => path !== 'saved').toJS();

  apiUpdateWebSettings({ data })
    .then(() => dispatch({ type: SETTING_SAVE } satisfies SettingSaveAction))
    .catch((error: unknown) => dispatch(showAlertForError(error)));
}, 2000, { leading: true, trailing: true });

export function saveSettings() {
  return (dispatch: AppDispatch, getState: GetState) => debouncedSave(dispatch, getState);
}
