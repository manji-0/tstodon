import type { Reducer } from '@reduxjs/toolkit';
import { Map as ImmutableMap, List as ImmutableList, fromJS } from 'immutable';

import type { ApiStatusEditJSON } from '@tstodon/api';
import {
  HISTORY_FETCH_REQUEST,
  HISTORY_FETCH_SUCCESS,
  HISTORY_FETCH_FAIL,
} from 'mastodon/actions/history';
import type {
  fetchHistoryFail,
  fetchHistoryRequest,
  fetchHistorySuccess,
} from 'mastodon/actions/history';
import type { MediaAttachment } from 'mastodon/models/media_attachment';
import { immutableMapOf } from 'mastodon/utils/immutable_map_of';
import type { ImmutableMapOf } from 'mastodon/utils/immutable_map_of';

import { matchAction } from './match_action';

/**
 * One version of a status (`GET /api/v1/statuses/:id/history`): its account
 * is the account's id, its poll, attachments and emojis are Immutable
 * collections (as `fromJS` converts them), and `original` marks the first
 * version.
 */
export type HistoryItemFields = {
  content: string;
  spoiler_text: string;
  sensitive: boolean;
  created_at: string;
  account: string;
  poll: ImmutableMap<string, unknown> | null;
  media_attachments: ImmutableList<MediaAttachment>;
  emojis: ImmutableList<ImmutableMap<string, unknown>>;
  original: boolean;
};
export type HistoryItem = ImmutableMapOf<HistoryItemFields>;

type HistoryFields = {
  loading: boolean;
  items: ImmutableList<HistoryItem>;
};
export type History = ImmutableMapOf<HistoryFields>;

type HistoryAction =
  | ReturnType<typeof fetchHistoryRequest>
  | ReturnType<typeof fetchHistorySuccess>
  | ReturnType<typeof fetchHistoryFail>;

const isHistoryAction = matchAction<HistoryAction>(
  HISTORY_FETCH_REQUEST,
  HISTORY_FETCH_SUCCESS,
  HISTORY_FETCH_FAIL,
);

const initialHistory: History = immutableMapOf<HistoryFields>({
  loading: false,
  items: ImmutableList(),
});

const initialState = ImmutableMap<string, History>();
type State = typeof initialState;

const historyItem = (
  { account, poll, media_attachments, emojis, ...edit }: ApiStatusEditJSON,
  original: boolean,
): HistoryItem =>
  immutableMapOf<HistoryItemFields>({
    ...edit,
    account: account.id,
    poll: poll && fromJS(poll),
    media_attachments: ImmutableList(media_attachments.map((media) => fromJS(media))),
    emojis: ImmutableList(emojis.map((emoji) => fromJS(emoji))),
    original,
  });

export const historyReducer: Reducer<State> = (state = initialState, action) => {
  if (!isHistoryAction(action)) {
    return state;
  }

  switch (action.type) {
    case HISTORY_FETCH_REQUEST:
      return state.update(action.statusId, initialHistory, (history) =>
        history.withMutations((map) => {
          map.set('loading', true);
          map.set('items', ImmutableList());
        }),
      );
    case HISTORY_FETCH_SUCCESS:
      return state.update(action.statusId, initialHistory, (history) =>
        history.withMutations((map) => {
          map.set('loading', false);
          map.set(
            'items',
            ImmutableList(
              action.history.map((edit, i) => historyItem(edit, i === 0)),
            ).reverse(),
          );
        }),
      );
    case HISTORY_FETCH_FAIL:
      return state.update(action.statusId, initialHistory, (history) =>
        history.set('loading', false),
      );
  }
};

export default historyReducer;
