import type { AppDispatch } from 'mastodon/store';

import type { SettingPath } from './settings';
import { saveSettings } from './settings';

export const COLUMN_ADD           = 'COLUMN_ADD';
export const COLUMN_REMOVE        = 'COLUMN_REMOVE';
export const COLUMN_MOVE          = 'COLUMN_MOVE';
export const COLUMN_PARAMS_CHANGE = 'COLUMN_PARAMS_CHANGE';

export function addColumn(id: string, params: Record<string, unknown>) {
  return (dispatch: AppDispatch) => {
    dispatch({
      type: COLUMN_ADD,
      id,
      params,
    });

    dispatch(saveSettings());
  };
}

export function removeColumn(uuid: string) {
  return (dispatch: AppDispatch) => {
    dispatch({
      type: COLUMN_REMOVE,
      uuid,
    });

    dispatch(saveSettings());
  };
}

export function moveColumn(uuid: string, direction: number) {
  return (dispatch: AppDispatch) => {
    dispatch({
      type: COLUMN_MOVE,
      uuid,
      direction,
    });

    dispatch(saveSettings());
  };
}

export function changeColumnParams(uuid: string, path: SettingPath, value: unknown) {
  return (dispatch: AppDispatch) => {
    dispatch({
      type: COLUMN_PARAMS_CHANGE,
      uuid,
      path,
      value,
    });

    dispatch(saveSettings());
  };
}
