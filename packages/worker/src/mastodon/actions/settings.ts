import { debounce } from 'lodash';

import { apiUpdateWebSettings } from 'mastodon/api/web_settings';
import type { AppDispatch, GetState } from 'mastodon/store';

import { showAlertForError } from './alerts';

export const SETTING_CHANGE = 'SETTING_CHANGE';
export const SETTING_SAVE   = 'SETTING_SAVE';

/** A path in the settings (`['notifications', 'alerts', 'follow']`). */
export type SettingPath = readonly (string | number)[];

export function changeSetting(path: SettingPath, value: unknown) {
  return (dispatch: AppDispatch) => {
    dispatch({
      type: SETTING_CHANGE,
      path,
      value,
    });

    dispatch(saveSettings());
  };
}

const debouncedSave = debounce((dispatch: AppDispatch, getState: GetState) => {
  if (getState().settings.get('saved') || !getState().meta.get('me')) {
    return;
  }

  const data = getState().settings.filter((_, path) => path !== 'saved').toJS();

  apiUpdateWebSettings({ data })
    .then(() => dispatch({ type: SETTING_SAVE }))
    .catch((error: unknown) => dispatch(showAlertForError(error)));
}, 2000, { leading: true, trailing: true });

export function saveSettings() {
  return (dispatch: AppDispatch, getState: GetState) => debouncedSave(dispatch, getState);
}
