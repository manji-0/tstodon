import { createReducer } from '@reduxjs/toolkit';
import { isAxiosError } from 'axios';
import { Map as ImmutableMap, List as ImmutableList } from 'immutable';

import type { ApiWebSettingsJSON } from '@tstodon/api';

import {
  COLUMN_ADD,
  COLUMN_REMOVE,
  COLUMN_MOVE,
  COLUMN_PARAMS_CHANGE,
} from '../actions/columns';
import type {
  ColumnAddAction,
  ColumnMoveAction,
  ColumnParamsChangeAction,
  ColumnRemoveAction,
} from '../actions/columns';
import { COMPOSE_LANGUAGE_CHANGE } from '../actions/compose';
import type { changeComposeLanguage } from '../actions/compose';
import { EMOJI_USE } from '../actions/emojis';
import type { EmojiUseAction } from '../actions/emojis';
import { LIST_DELETE_SUCCESS, LIST_FETCH_FAIL } from '../actions/lists';
import type { deleteListSuccess, fetchListFail } from '../actions/lists';
import { NOTIFICATIONS_FILTER_SET } from '../actions/notifications';
import { SETTING_CHANGE, SETTING_SAVE } from '../actions/settings';
import type { SettingChangeAction } from '../actions/settings';
import { STORE_HYDRATE } from '../actions/store';
import type { StoreHydrateAction } from '../actions/store';
import { immutableFromJS, immutableMapOf } from '../utils/immutable_map_of';
import type { ImmutableMapOf, ImmutableOf } from '../utils/immutable_map_of';
import type { NotificationSettingKey } from '../utils/notifications';
import type { PlainActionOf } from '../utils/types';
import { uuid } from '../uuid';

/** A column of the advanced layout, as `addColumn` makes it. */
export interface ColumnJSON {
  /** Its type: `'HOME'`, `'NOTIFICATIONS'`, `'LIST'`, ... */
  id: string;
  uuid: string;
  /** What the column type keeps (a list's `id`, `other.onlyMedia`, ...). */
  params: Record<string, unknown>;
}

export type Column = ImmutableOf<ColumnJSON>;

/** Whether each kind of notification is alerted, shown or sounded. */
export type NotificationToggles = ImmutableMapOf<
  Record<NotificationSettingKey, boolean>
>;

interface QuickFilterShape {
  /** `'all'`, or the one type the filter bar shows. */
  active: string;
  show: boolean;
  advanced: boolean;
}

export interface NotificationSettingsShape {
  /** Desktop notifications. */
  alerts: NotificationToggles;
  quickFilter: ImmutableMapOf<QuickFilterShape>;
  dismissPermissionBanner: boolean;
  showUnread: boolean;
  minimizeFilteredBanner: boolean;
  /** In the column. */
  shows: NotificationToggles;
  sounds: NotificationToggles;
  group: ImmutableMapOf<{ follow: boolean }>;
}

interface RegexShape {
  body: string;
}

type RegexSettings = ImmutableMapOf<RegexShape>;

interface HomeShowsShape {
  quote: boolean;
  reblog: boolean;
  reply: boolean;
}

interface HomeSettingsShape {
  shows: ImmutableMapOf<HomeShowsShape>;
  regex: RegexSettings;
}

/** The settings of the community and public timelines. */
interface TimelineSettingsShape {
  regex: RegexSettings;
  /** Written by the column settings' toggles; missing until one is used. */
  other?: ImmutableMapOf<{ onlyMedia?: boolean; onlyRemote?: boolean }>;
}

/**
 * The web UI's settings, saved to `/api/web/settings` (without `saved`) and
 * hydrated from the initial state's `settings`.
 */
export interface SettingsShape {
  /** Whether the server has the current settings (not saved itself). */
  saved: boolean;
  skinTone: number;
  trends: ImmutableMapOf<{ show: boolean }>;
  home: ImmutableMapOf<HomeSettingsShape>;
  notifications: ImmutableMapOf<NotificationSettingsShape>;
  firehose: ImmutableMapOf<{ onlyMedia: boolean }>;
  community: ImmutableMapOf<TimelineSettingsShape>;
  public: ImmutableMapOf<TimelineSettingsShape>;
  direct: ImmutableMapOf<{ regex: RegexSettings }>;
  /** By banner (or other dismissible) id. */
  dismissed_banners: ImmutableMap<string, boolean>;
  /** The advanced layout's columns: missing until the store is hydrated. */
  columns?: ImmutableList<Column>;
  /** Uses by emoji id; missing until one is used. */
  frequentlyUsedEmojis?: ImmutableMap<string, number>;
  /** Uses by language code; missing until one is used. */
  frequentlyUsedLanguages?: ImmutableMap<string, number>;
  /** The version of the introduction the viewer has seen. */
  introductionVersion?: number;
}

export type SettingsState = ImmutableMapOf<SettingsShape>;

const notificationToggles = (
  toggles: Record<NotificationSettingKey, boolean>,
): NotificationToggles => immutableMapOf(toggles);

const initialState: SettingsState = immutableMapOf<SettingsShape>({
  saved: true,

  skinTone: 1,

  trends: immutableMapOf<{ show: boolean }>({
    show: true,
  }),

  home: immutableMapOf<HomeSettingsShape>({
    shows: immutableMapOf<HomeShowsShape>({
      quote: true,
      reblog: true,
      reply: true,
    }),

    regex: immutableMapOf<RegexShape>({
      body: '',
    }),
  }),

  notifications: immutableMapOf<NotificationSettingsShape>({
    alerts: notificationToggles({
      follow: false,
      follow_request: false,
      favourite: false,
      reblog: false,
      quote: false,
      mention: false,
      poll: false,
      status: false,
      update: false,
      collections: false,
      'admin.sign_up': false,
      'admin.report': false,
    }),

    quickFilter: immutableMapOf<QuickFilterShape>({
      active: 'all',
      show: true,
      advanced: false,
    }),

    dismissPermissionBanner: false,
    showUnread: true,
    minimizeFilteredBanner: false,

    shows: notificationToggles({
      follow: true,
      follow_request: false,
      favourite: true,
      reblog: true,
      quote: true,
      mention: true,
      poll: true,
      status: true,
      update: true,
      collections: true,
      'admin.sign_up': true,
      'admin.report': true,
    }),

    sounds: notificationToggles({
      follow: true,
      follow_request: false,
      favourite: true,
      reblog: true,
      quote: true,
      mention: true,
      poll: true,
      status: true,
      update: true,
      collections: true,
      'admin.sign_up': true,
      'admin.report': true,
    }),

    group: immutableMapOf<{ follow: boolean }>({
      follow: true,
    }),
  }),

  firehose: immutableMapOf<{ onlyMedia: boolean }>({
    onlyMedia: false,
  }),

  community: immutableMapOf<TimelineSettingsShape>({
    regex: immutableMapOf<RegexShape>({
      body: '',
    }),
  }),

  public: immutableMapOf<TimelineSettingsShape>({
    regex: immutableMapOf<RegexShape>({
      body: '',
    }),
  }),

  direct: immutableMapOf<{ regex: RegexSettings }>({
    regex: immutableMapOf<RegexShape>({
      body: '',
    }),
  }),

  dismissed_banners: ImmutableMap({
    'public_timeline': false,
    'community_timeline': false,
    'home/follow-suggestions': false,
    'explore/links': false,
    'explore/statuses': false,
    'explore/tags': false,
    'notifications/remove_quote_hint': false,
    'quote/quiet_post_hint': false,
  }),
});

const defaultColumns = immutableFromJS<ColumnJSON[]>([
  { id: 'COMPOSE', uuid: uuid(), params: {} },
  { id: 'HOME', uuid: uuid(), params: {} },
  { id: 'NOTIFICATIONS', uuid: uuid(), params: {} },
]);

/**
 * The saved settings, taken as this UI saved them: the server stores
 * `ApiWebSettingsJSON` as an opaque object and returns it as it is, and they
 * are merged without checking, as upstream does.
 */
function savedSettings(
  settings: ImmutableOf<ApiWebSettingsJSON>,
): ImmutableMapOf<Partial<SettingsShape>>;
function savedSettings(settings: ImmutableOf<ApiWebSettingsJSON>): unknown {
  return settings;
}

const hydrate = (
  state: SettingsState,
  settings: ImmutableOf<ApiWebSettingsJSON> | undefined,
) =>
  (settings ? state.mergeDeep(savedSettings(settings)) : state).update(
    'columns',
    (val = defaultColumns) => val,
  );

/** Before the store is hydrated there are no columns, and nothing to change. */
const updateColumns = (
  state: SettingsState,
  updater: (columns: ImmutableList<Column>) => ImmutableList<Column>,
) => {
  const columns = state.get('columns');

  return columns ? state.set('columns', updater(columns)) : state;
};

const moveColumn = (state: SettingsState, uuid: string, direction: number) => {
  const columns = state.get('columns');

  if (!columns) return state;

  const index = columns.findIndex((item) => item.get('uuid') === uuid);
  const newIndex = index + direction;
  // `get(-1)` is the last column, which upstream moved for an unknown uuid
  const column = columns.get(index);

  if (!column) return state;

  let newColumns;

  newColumns = columns.splice(index, 1);
  newColumns = newColumns.splice(newIndex, 0, column);

  return state.set('columns', newColumns).set('saved', false);
};

const changeColumnParams = (
  state: SettingsState,
  uuid: string,
  path: readonly (string | number)[],
  value: unknown,
) =>
  updateColumns(state, (columns) => {
    const index = columns.findIndex((item) => item.get('uuid') === uuid);

    return columns.update(
      index,
      (column) => column && column.updateIn(['params', ...path], () => value),
    );
  }).set('saved', false);

const updateFrequentEmojis = (
  state: SettingsState,
  emoji: EmojiUseAction['emoji'],
) =>
  state
    .update('frequentlyUsedEmojis', ImmutableMap<string, number>(), (map) =>
      map.update(emoji.id, 0, (count) => count + 1),
    )
    .set('saved', false);

const updateFrequentLanguages = (state: SettingsState, language: string) =>
  state
    .update('frequentlyUsedLanguages', ImmutableMap<string, number>(), (map) =>
      map.update(language, 0, (count) => count + 1),
    )
    .set('saved', false);

const filterDeadListColumns = (state: SettingsState, listId: string) =>
  updateColumns(state, (columns) =>
    columns.filterNot(
      (column) =>
        column.get('id') === 'LIST' &&
        column.get('params').get('id') === listId,
    ),
  );

const changeSetting = (
  state: SettingsState,
  action: SettingChangeAction<string>,
) => state.setIn(action.path, action.value).set('saved', false);

export default createReducer(initialState, (builder) => {
  builder
    .addCase(STORE_HYDRATE, (state, action: StoreHydrateAction) =>
      hydrate(state, action.state.get('settings')),
    )
    .addCase(
      NOTIFICATIONS_FILTER_SET,
      (
        state,
        action: SettingChangeAction<typeof NOTIFICATIONS_FILTER_SET>,
      ) => changeSetting(state, action),
    )
    .addCase(SETTING_CHANGE, (state, action: SettingChangeAction) =>
      changeSetting(state, action),
    )
    .addCase(COLUMN_ADD, (state, action: ColumnAddAction) =>
      updateColumns(state, (list) =>
        list.push(
          immutableFromJS<ColumnJSON>({
            id: action.id,
            uuid: uuid(),
            params: action.params,
          }),
        ),
      ).set('saved', false),
    )
    .addCase(COLUMN_REMOVE, (state, action: ColumnRemoveAction) =>
      updateColumns(state, (list) =>
        list.filterNot((item) => item.get('uuid') === action.uuid),
      ).set('saved', false),
    )
    .addCase(COLUMN_MOVE, (state, action: ColumnMoveAction) =>
      moveColumn(state, action.uuid, action.direction),
    )
    .addCase(COLUMN_PARAMS_CHANGE, (state, action: ColumnParamsChangeAction) =>
      changeColumnParams(state, action.uuid, action.path, action.value),
    )
    .addCase(EMOJI_USE, (state, action: EmojiUseAction) =>
      updateFrequentEmojis(state, action.emoji),
    )
    .addCase(
      COMPOSE_LANGUAGE_CHANGE,
      (
        state,
        action: PlainActionOf<
          typeof COMPOSE_LANGUAGE_CHANGE,
          typeof changeComposeLanguage
        >,
      ) => updateFrequentLanguages(state, action.language),
    )
    .addCase(SETTING_SAVE, (state) => state.set('saved', true))
    .addCase(LIST_FETCH_FAIL, (state, action: ReturnType<typeof fetchListFail>) =>
      // Upstream read `error.response.status`, which threw on an error
      // without a response (a network error).
      isAxiosError(action.error) && action.error.response?.status === 404
        ? filterDeadListColumns(state, action.id)
        : state,
    )
    .addCase(
      LIST_DELETE_SUCCESS,
      (state, action: ReturnType<typeof deleteListSuccess>) =>
        filterDeadListColumns(state, action.id),
    );
});
