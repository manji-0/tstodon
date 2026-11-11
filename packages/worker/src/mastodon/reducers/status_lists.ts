import { createReducer } from '@reduxjs/toolkit';
import { OrderedSet as ImmutableOrderedSet } from 'immutable';

import { getNextLinkUri } from 'mastodon/api';
import type { Status } from 'mastodon/models/status';

import { blockAccountSuccess, muteAccountSuccess } from '../actions/accounts';
import {
  BOOKMARKED_STATUSES_FETCH_REQUEST,
  BOOKMARKED_STATUSES_FETCH_SUCCESS,
  BOOKMARKED_STATUSES_FETCH_FAIL,
  BOOKMARKED_STATUSES_EXPAND_REQUEST,
  BOOKMARKED_STATUSES_EXPAND_SUCCESS,
  BOOKMARKED_STATUSES_EXPAND_FAIL,
} from '../actions/bookmarks';
import type {
  fetchBookmarkedStatusesRequest,
  fetchBookmarkedStatusesSuccess,
  fetchBookmarkedStatusesFail,
  expandBookmarkedStatusesRequest,
  expandBookmarkedStatusesSuccess,
  expandBookmarkedStatusesFail,
} from '../actions/bookmarks';
import {
  FAVOURITED_STATUSES_FETCH_REQUEST,
  FAVOURITED_STATUSES_FETCH_SUCCESS,
  FAVOURITED_STATUSES_FETCH_FAIL,
  FAVOURITED_STATUSES_EXPAND_REQUEST,
  FAVOURITED_STATUSES_EXPAND_SUCCESS,
  FAVOURITED_STATUSES_EXPAND_FAIL,
} from '../actions/favourites';
import type {
  fetchFavouritedStatusesRequest,
  fetchFavouritedStatusesSuccess,
  fetchFavouritedStatusesFail,
  expandFavouritedStatusesRequest,
  expandFavouritedStatusesSuccess,
  expandFavouritedStatusesFail,
} from '../actions/favourites';
import {
  FAVOURITE_SUCCESS,
  UNFAVOURITE_SUCCESS,
  BOOKMARK_SUCCESS,
  UNBOOKMARK_SUCCESS,
  PIN_SUCCESS,
  UNPIN_SUCCESS,
} from '../actions/interactions';
import type {
  favouriteSuccess,
  unfavouriteSuccess,
  bookmarkSuccess,
  unbookmarkSuccess,
  pinSuccess,
  unpinSuccess,
} from '../actions/interactions';
import { fetchQuotes } from '../actions/interactions_typed';
import { PINNED_STATUSES_FETCH_SUCCESS } from '../actions/pin_statuses';
import type { fetchPinnedStatusesSuccess } from '../actions/pin_statuses';
import {
  TRENDS_STATUSES_FETCH_REQUEST,
  TRENDS_STATUSES_FETCH_SUCCESS,
  TRENDS_STATUSES_FETCH_FAIL,
  TRENDS_STATUSES_EXPAND_REQUEST,
  TRENDS_STATUSES_EXPAND_SUCCESS,
  TRENDS_STATUSES_EXPAND_FAIL,
} from '../actions/trends';
import type {
  fetchTrendingStatusesRequest,
  fetchTrendingStatusesSuccess,
  fetchTrendingStatusesFail,
  expandTrendingStatusesRequest,
  expandTrendingStatusesSuccess,
  expandTrendingStatusesFail,
} from '../actions/trends';

import type {
  StatusList,
  StatusListFields,
  StatusListKey,
  StatusListsState,
} from '../models/status_list';
import { immutableMapOf } from '../utils/immutable_map_of';

import { matchAction } from './match_action';

const newList = (): StatusList =>
  immutableMapOf<StatusListFields>({
    next: null,
    loaded: false,
    items: ImmutableOrderedSet<string>(),
  });

const initialState: StatusListsState = immutableMapOf<
  Record<StatusListKey, StatusList>
>({
  favourites: newList(),
  bookmarks: newList(),
  pins: newList(),
  trending: newList(),
  quotes: newList().set('statusId', null),
});

const updateList = (
  state: StatusListsState,
  listType: StatusListKey,
  updater: (list: StatusList) => StatusList,
) => state.update(listType, newList(), updater);

const normalizeList = (
  state: StatusListsState,
  listType: StatusListKey,
  statuses: { id: string }[],
  next: string | null,
) => {
  return updateList(state, listType, (listMap) =>
    listMap.withMutations((map) => {
      map.set('next', next);
      map.set('loaded', true);
      map.set('isLoading', false);
      map.set('items', ImmutableOrderedSet(statuses.map((item) => item.id)));
    }),
  );
};

const appendToList = (
  state: StatusListsState,
  listType: StatusListKey,
  statuses: { id: string }[],
  next: string | null,
) => {
  return updateList(state, listType, (listMap) =>
    listMap.withMutations((map) => {
      map.set('next', next);
      map.set('isLoading', false);
      map.set(
        'items',
        map.get('items').union(statuses.map((item) => item.id)),
      );
    }),
  );
};

const prependOneToList = (
  state: StatusListsState,
  listType: StatusListKey,
  status: Status,
) => {
  const statusId = status.get('id') as string;
  return updateList(state, listType, (list) => {
    const items = list.get('items');
    return items.includes(statusId)
      ? list
      : list.set('items', ImmutableOrderedSet([statusId]).union(items));
  });
};

const removeOneFromList = (
  state: StatusListsState,
  listType: StatusListKey,
  status: Status,
) => {
  return updateList(state, listType, (list) =>
    list.set('items', list.get('items').delete(status.get('id') as string)),
  );
};

const setLoading = (
  state: StatusListsState,
  listType: StatusListKey,
  isLoading: boolean,
) => state.setIn([listType, 'isLoading'], isLoading);

const isFavouritedFetchRequest = matchAction<
  ReturnType<typeof fetchFavouritedStatusesRequest>
>(FAVOURITED_STATUSES_FETCH_REQUEST);
const isFavouritedExpandRequest = matchAction<
  ReturnType<typeof expandFavouritedStatusesRequest>
>(FAVOURITED_STATUSES_EXPAND_REQUEST);
const isFavouritedFetchFail = matchAction<
  ReturnType<typeof fetchFavouritedStatusesFail>
>(FAVOURITED_STATUSES_FETCH_FAIL);
const isFavouritedExpandFail = matchAction<
  ReturnType<typeof expandFavouritedStatusesFail>
>(FAVOURITED_STATUSES_EXPAND_FAIL);
const isFavouritedFetchSuccess = matchAction<
  ReturnType<typeof fetchFavouritedStatusesSuccess>
>(FAVOURITED_STATUSES_FETCH_SUCCESS);
const isFavouritedExpandSuccess = matchAction<
  ReturnType<typeof expandFavouritedStatusesSuccess>
>(FAVOURITED_STATUSES_EXPAND_SUCCESS);
const isBookmarkedFetchRequest = matchAction<
  ReturnType<typeof fetchBookmarkedStatusesRequest>
>(BOOKMARKED_STATUSES_FETCH_REQUEST);
const isBookmarkedExpandRequest = matchAction<
  ReturnType<typeof expandBookmarkedStatusesRequest>
>(BOOKMARKED_STATUSES_EXPAND_REQUEST);
const isBookmarkedFetchFail = matchAction<
  ReturnType<typeof fetchBookmarkedStatusesFail>
>(BOOKMARKED_STATUSES_FETCH_FAIL);
const isBookmarkedExpandFail = matchAction<
  ReturnType<typeof expandBookmarkedStatusesFail>
>(BOOKMARKED_STATUSES_EXPAND_FAIL);
const isBookmarkedFetchSuccess = matchAction<
  ReturnType<typeof fetchBookmarkedStatusesSuccess>
>(BOOKMARKED_STATUSES_FETCH_SUCCESS);
const isBookmarkedExpandSuccess = matchAction<
  ReturnType<typeof expandBookmarkedStatusesSuccess>
>(BOOKMARKED_STATUSES_EXPAND_SUCCESS);
const isTrendingFetchRequest = matchAction<
  ReturnType<typeof fetchTrendingStatusesRequest>
>(TRENDS_STATUSES_FETCH_REQUEST);
const isTrendingExpandRequest = matchAction<
  ReturnType<typeof expandTrendingStatusesRequest>
>(TRENDS_STATUSES_EXPAND_REQUEST);
const isTrendingFetchFail = matchAction<
  ReturnType<typeof fetchTrendingStatusesFail>
>(TRENDS_STATUSES_FETCH_FAIL);
const isTrendingExpandFail = matchAction<
  ReturnType<typeof expandTrendingStatusesFail>
>(TRENDS_STATUSES_EXPAND_FAIL);
const isTrendingFetchSuccess = matchAction<
  ReturnType<typeof fetchTrendingStatusesSuccess>
>(TRENDS_STATUSES_FETCH_SUCCESS);
const isTrendingExpandSuccess = matchAction<
  ReturnType<typeof expandTrendingStatusesSuccess>
>(TRENDS_STATUSES_EXPAND_SUCCESS);
const isFavouriteSuccess =
  matchAction<ReturnType<typeof favouriteSuccess>>(FAVOURITE_SUCCESS);
const isUnfavouriteSuccess =
  matchAction<ReturnType<typeof unfavouriteSuccess>>(UNFAVOURITE_SUCCESS);
const isBookmarkSuccess =
  matchAction<ReturnType<typeof bookmarkSuccess>>(BOOKMARK_SUCCESS);
const isUnbookmarkSuccess =
  matchAction<ReturnType<typeof unbookmarkSuccess>>(UNBOOKMARK_SUCCESS);
const isPinnedFetchSuccess = matchAction<
  ReturnType<typeof fetchPinnedStatusesSuccess>
>(PINNED_STATUSES_FETCH_SUCCESS);
const isPinSuccess = matchAction<ReturnType<typeof pinSuccess>>(PIN_SUCCESS);
const isUnpinSuccess =
  matchAction<ReturnType<typeof unpinSuccess>>(UNPIN_SUCCESS);

const statusListsReducer = createReducer(initialState, (builder) => {
  builder
    .addCase(blockAccountSuccess, (state, action) =>
      updateList(state, 'trending', (list) =>
        list.set(
          'items',
          list.get('items').filterNot(
            (statusId) =>
              action.payload.statuses.getIn([statusId, 'account']) ===
              action.payload.relationship.id,
          ),
        ),
      ),
    )
    .addCase(muteAccountSuccess, (state, action) =>
      updateList(state, 'trending', (list) =>
        list.set(
          'items',
          list.get('items').filterNot(
            (statusId) =>
              action.payload.statuses.getIn([statusId, 'account']) ===
              action.payload.relationship.id,
          ),
        ),
      ),
    )
    .addCase(fetchQuotes.fulfilled, (state, action) => {
      // The payload carries the page's links, not its `next` URL, and the
      // first page (`replace`) replaces the list where a next page extends it.
      const { statuses, links, replace } = action.payload;
      const next = getNextLinkUri(links);
      return (
        replace
          ? normalizeList(state, 'quotes', statuses, next)
          : appendToList(state, 'quotes', statuses, next)
      ).setIn(['quotes', 'statusId'], action.meta.arg.statusId);
    })
    .addCase(fetchQuotes.pending, (state, action) =>
      setLoading(state, 'quotes', true).setIn(
        ['quotes', 'statusId'],
        action.meta.arg.statusId,
      ),
    )
    .addCase(fetchQuotes.rejected, (state, action) =>
      setLoading(state, 'quotes', false).setIn(
        ['quotes', 'statusId'],
        action.meta.arg.statusId,
      ),
    )
    .addMatcher(isFavouritedFetchRequest, (state) =>
      setLoading(state, 'favourites', true),
    )
    .addMatcher(isFavouritedExpandRequest, (state) =>
      setLoading(state, 'favourites', true),
    )
    .addMatcher(isFavouritedFetchFail, (state) =>
      setLoading(state, 'favourites', false),
    )
    .addMatcher(isFavouritedExpandFail, (state) =>
      setLoading(state, 'favourites', false),
    )
    .addMatcher(isFavouritedFetchSuccess, (state, action) =>
      normalizeList(state, 'favourites', action.statuses, action.next),
    )
    .addMatcher(isFavouritedExpandSuccess, (state, action) =>
      appendToList(state, 'favourites', action.statuses, action.next),
    )
    .addMatcher(isBookmarkedFetchRequest, (state) =>
      setLoading(state, 'bookmarks', true),
    )
    .addMatcher(isBookmarkedExpandRequest, (state) =>
      setLoading(state, 'bookmarks', true),
    )
    .addMatcher(isBookmarkedFetchFail, (state) =>
      setLoading(state, 'bookmarks', false),
    )
    .addMatcher(isBookmarkedExpandFail, (state) =>
      setLoading(state, 'bookmarks', false),
    )
    .addMatcher(isBookmarkedFetchSuccess, (state, action) =>
      normalizeList(state, 'bookmarks', action.statuses, action.next),
    )
    .addMatcher(isBookmarkedExpandSuccess, (state, action) =>
      appendToList(state, 'bookmarks', action.statuses, action.next),
    )
    .addMatcher(isTrendingFetchRequest, (state) =>
      setLoading(state, 'trending', true),
    )
    .addMatcher(isTrendingExpandRequest, (state) =>
      setLoading(state, 'trending', true),
    )
    .addMatcher(isTrendingFetchFail, (state) =>
      setLoading(state, 'trending', false),
    )
    .addMatcher(isTrendingExpandFail, (state) =>
      setLoading(state, 'trending', false),
    )
    .addMatcher(isTrendingFetchSuccess, (state, action) =>
      normalizeList(state, 'trending', action.statuses, action.next),
    )
    .addMatcher(isTrendingExpandSuccess, (state, action) =>
      appendToList(state, 'trending', action.statuses, action.next),
    )
    .addMatcher(isFavouriteSuccess, (state, action) =>
      prependOneToList(state, 'favourites', action.status),
    )
    .addMatcher(isUnfavouriteSuccess, (state, action) =>
      removeOneFromList(state, 'favourites', action.status),
    )
    .addMatcher(isBookmarkSuccess, (state, action) =>
      prependOneToList(state, 'bookmarks', action.status),
    )
    .addMatcher(isUnbookmarkSuccess, (state, action) =>
      removeOneFromList(state, 'bookmarks', action.status),
    )
    .addMatcher(isPinnedFetchSuccess, (state, action) =>
      normalizeList(state, 'pins', action.statuses, action.next),
    )
    .addMatcher(isPinSuccess, (state, action) =>
      prependOneToList(state, 'pins', action.status),
    )
    .addMatcher(isUnpinSuccess, (state, action) =>
      removeOneFromList(state, 'pins', action.status),
    );
});

export default statusListsReducer;
