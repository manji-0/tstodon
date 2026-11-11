import { AxiosError, AxiosHeaders } from 'axios';

import {
  COLUMN_ADD,
  COLUMN_MOVE,
  COLUMN_PARAMS_CHANGE,
  COLUMN_REMOVE,
} from '../actions/columns';
import type {
  ColumnAddAction,
  ColumnMoveAction,
  ColumnParamsChangeAction,
  ColumnRemoveAction,
} from '../actions/columns';
import { changeComposeLanguage } from '../actions/compose';
import { EMOJI_USE } from '../actions/emojis';
import type { EmojiUseAction } from '../actions/emojis';
import { deleteListSuccess, fetchListFail } from '../actions/lists';
import { NOTIFICATIONS_FILTER_SET } from '../actions/notifications';
import { SETTING_CHANGE, SETTING_SAVE } from '../actions/settings';
import type {
  SettingChangeAction,
  SettingSaveAction,
} from '../actions/settings';
import { STORE_HYDRATE } from '../actions/store';
import type { HydrateState, StoreHydrateAction } from '../actions/store';
import { immutableFromJS } from '../utils/immutable_map_of';

import settings from './settings';

const hydrate = (state: HydrateState): StoreHydrateAction => ({
  type: STORE_HYDRATE,
  state: immutableFromJS(state),
});

const savedColumns = [
  { id: 'HOME', uuid: 'a', params: {} },
  { id: 'LIST', uuid: 'b', params: { id: '5' } },
  { id: 'PUBLIC', uuid: 'c', params: { other: { onlyMedia: true } } },
];

const hydrated = () =>
  settings(
    undefined,
    hydrate({
      settings: {
        skinTone: 3,
        notifications: { alerts: { follow: true } },
        columns: savedColumns,
      },
    }),
  );

const columnIds = (state: ReturnType<typeof settings>) =>
  state
    .get('columns')
    ?.map((column) => column.get('uuid'))
    .toArray();

const change = (
  path: SettingChangeAction['path'],
  value: unknown,
): SettingChangeAction => ({ type: SETTING_CHANGE, path, value });

const notFound = () =>
  new AxiosError('Not Found', '404', undefined, undefined, {
    status: 404,
    statusText: 'Not Found',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: {},
  });

describe('settings reducer', () => {
  it('starts saved, with the default settings and no columns', () => {
    const state = settings(undefined, { type: 'INIT' });

    expect(state.get('saved')).toBe(true);
    expect(state.get('skinTone')).toBe(1);
    expect(state.get('notifications').get('shows').get('follow_request')).toBe(
      false,
    );
    expect(state.get('notifications').get('quickFilter').toJS()).toEqual({
      active: 'all',
      show: true,
      advanced: false,
    });
    expect(state.has('columns')).toBe(false);
  });

  it('merges the saved settings into the defaults', () => {
    const state = hydrated();

    expect(state.get('skinTone')).toBe(3);
    expect(state.get('notifications').get('alerts').get('follow')).toBe(true);
    expect(state.get('notifications').get('alerts').get('mention')).toBe(
      false,
    );
    expect(state.get('columns')?.toJS()).toEqual(savedColumns);
  });

  it('adds the default columns when none are saved', () => {
    const state = settings(undefined, hydrate({ settings: {} }));

    expect(state.get('columns')?.map((c) => c.get('id')).toArray()).toEqual([
      'COMPOSE',
      'HOME',
      'NOTIFICATIONS',
    ]);
  });

  it('changes a setting, unsaved until it is saved', () => {
    let state = settings(
      hydrated(),
      change(['notifications', 'sounds', 'mention'], false),
    );
    expect(state.get('notifications').get('sounds').get('mention')).toBe(
      false,
    );
    expect(state.get('saved')).toBe(false);

    const save: SettingSaveAction = { type: SETTING_SAVE };
    state = settings(state, save);
    expect(state.get('saved')).toBe(true);
  });

  it('sets the notification filter', () => {
    const action: SettingChangeAction<typeof NOTIFICATIONS_FILTER_SET> = {
      type: NOTIFICATIONS_FILTER_SET,
      path: ['notifications', 'quickFilter', 'active'],
      value: 'mention',
    };
    const state = settings(hydrated(), action);

    expect(state.get('notifications').get('quickFilter').get('active')).toBe(
      'mention',
    );
    expect(state.get('saved')).toBe(false);
  });

  it('adds, moves, changes and removes columns', () => {
    const add: ColumnAddAction = {
      type: COLUMN_ADD,
      id: 'HASHTAG',
      params: { id: 'cats' },
    };
    let state = settings(hydrated(), add);
    const added = state.get('columns')?.last();
    expect(added?.get('id')).toBe('HASHTAG');
    expect(added?.get('params').toJS()).toEqual({ id: 'cats' });
    expect(state.get('saved')).toBe(false);

    const move: ColumnMoveAction = {
      type: COLUMN_MOVE,
      uuid: 'a',
      direction: 1,
    };
    state = settings(state, move);
    expect(columnIds(state)?.slice(0, 3)).toEqual(['b', 'a', 'c']);

    const params: ColumnParamsChangeAction = {
      type: COLUMN_PARAMS_CHANGE,
      uuid: 'c',
      path: ['other', 'onlyMedia'],
      value: false,
    };
    state = settings(state, params);
    expect(
      state.get('columns')?.get(2)?.get('params').toJS(),
    ).toEqual({ other: { onlyMedia: false } });

    const remove: ColumnRemoveAction = { type: COLUMN_REMOVE, uuid: 'a' };
    state = settings(state, remove);
    expect(columnIds(state)?.slice(0, 2)).toEqual(['b', 'c']);
  });

  it('counts the emojis and languages used', () => {
    const emoji: EmojiUseAction = { type: EMOJI_USE, emoji: { id: 'smile' } };
    let state = settings(undefined, emoji);
    state = settings(state, emoji);
    state = settings(state, changeComposeLanguage('de'));

    expect(state.get('frequentlyUsedEmojis')?.toJS()).toEqual({ smile: 2 });
    expect(state.get('frequentlyUsedLanguages')?.toJS()).toEqual({ de: 1 });
    expect(state.get('saved')).toBe(false);
  });

  it('removes the columns of a deleted list', () => {
    const state = settings(hydrated(), deleteListSuccess('5'));

    expect(columnIds(state)).toEqual(['a', 'c']);
  });

  it('removes the columns of a list that is gone, not of one that failed', () => {
    const initial = hydrated();

    expect(columnIds(settings(initial, fetchListFail('5', notFound())))).toEqual(
      ['a', 'c'],
    );
    expect(settings(initial, fetchListFail('5', new Error('Network')))).toBe(
      initial,
    );
  });
});
