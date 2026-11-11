import type { AppDispatch } from 'mastodon/store';

import type { SettingPath } from './settings';
import { saveSettings } from './settings';

export const COLUMN_ADD           = 'COLUMN_ADD' as const;
export const COLUMN_REMOVE        = 'COLUMN_REMOVE' as const;
export const COLUMN_MOVE          = 'COLUMN_MOVE' as const;
export const COLUMN_PARAMS_CHANGE = 'COLUMN_PARAMS_CHANGE' as const;

/** `COLUMN_ADD`: a column of the type `id` (`'HOME'`, `'LIST'`, ...). */
export type ColumnAddAction = {
  type: typeof COLUMN_ADD;
  id: string;
  params: Record<string, unknown>;
};

export type ColumnRemoveAction = {
  type: typeof COLUMN_REMOVE;
  uuid: string;
};

/** `COLUMN_MOVE`: by `direction` places (-1: left, 1: right). */
export type ColumnMoveAction = {
  type: typeof COLUMN_MOVE;
  uuid: string;
  direction: number;
};

/** `COLUMN_PARAMS_CHANGE`: sets `value` at `path` in the column's `params`. */
export type ColumnParamsChangeAction = {
  type: typeof COLUMN_PARAMS_CHANGE;
  uuid: string;
  path: SettingPath;
  value: unknown;
};

export function addColumn(id: string, params: Record<string, unknown>) {
  return (dispatch: AppDispatch) => {
    dispatch({
      type: COLUMN_ADD,
      id,
      params,
    } satisfies ColumnAddAction);

    dispatch(saveSettings());
  };
}

export function removeColumn(uuid: string) {
  return (dispatch: AppDispatch) => {
    dispatch({
      type: COLUMN_REMOVE,
      uuid,
    } satisfies ColumnRemoveAction);

    dispatch(saveSettings());
  };
}

export function moveColumn(uuid: string, direction: number) {
  return (dispatch: AppDispatch) => {
    dispatch({
      type: COLUMN_MOVE,
      uuid,
      direction,
    } satisfies ColumnMoveAction);

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
    } satisfies ColumnParamsChangeAction);

    dispatch(saveSettings());
  };
}
