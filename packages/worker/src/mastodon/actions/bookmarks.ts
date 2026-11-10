import { getNextLinkUri } from 'mastodon/api';
import { apiGetBookmarks } from 'mastodon/api/interactions';
import type { ApiStatusJSON } from 'mastodon/api_types/statuses';
import type { AppDispatch, GetState } from 'mastodon/store';

import { importFetchedStatuses } from './importer';

export const BOOKMARKED_STATUSES_FETCH_REQUEST = 'BOOKMARKED_STATUSES_FETCH_REQUEST';
export const BOOKMARKED_STATUSES_FETCH_SUCCESS = 'BOOKMARKED_STATUSES_FETCH_SUCCESS';
export const BOOKMARKED_STATUSES_FETCH_FAIL    = 'BOOKMARKED_STATUSES_FETCH_FAIL';

export const BOOKMARKED_STATUSES_EXPAND_REQUEST = 'BOOKMARKED_STATUSES_EXPAND_REQUEST';
export const BOOKMARKED_STATUSES_EXPAND_SUCCESS = 'BOOKMARKED_STATUSES_EXPAND_SUCCESS';
export const BOOKMARKED_STATUSES_EXPAND_FAIL    = 'BOOKMARKED_STATUSES_EXPAND_FAIL';

export function fetchBookmarkedStatuses() {
  return (dispatch: AppDispatch, getState: GetState) => {
    if (getState().status_lists.getIn(['bookmarks', 'isLoading'])) {
      return;
    }

    dispatch(fetchBookmarkedStatusesRequest());

    apiGetBookmarks().then(({ statuses, links }) => {
      dispatch(importFetchedStatuses(statuses));
      dispatch(fetchBookmarkedStatusesSuccess(statuses, getNextLinkUri(links)));
    }).catch((error: unknown) => {
      dispatch(fetchBookmarkedStatusesFail(error));
    });
  };
}

export function fetchBookmarkedStatusesRequest() {
  return {
    type: BOOKMARKED_STATUSES_FETCH_REQUEST,
  };
}

export function fetchBookmarkedStatusesSuccess(statuses: ApiStatusJSON[], next: string | null) {
  return {
    type: BOOKMARKED_STATUSES_FETCH_SUCCESS,
    statuses,
    next,
  };
}

export function fetchBookmarkedStatusesFail(error: unknown) {
  return {
    type: BOOKMARKED_STATUSES_FETCH_FAIL,
    error,
  };
}

export function expandBookmarkedStatuses() {
  return (dispatch: AppDispatch, getState: GetState) => {
    const url = getState().status_lists.getIn(['bookmarks', 'next'], null);

    if (typeof url !== 'string' || getState().status_lists.getIn(['bookmarks', 'isLoading'])) {
      return;
    }

    dispatch(expandBookmarkedStatusesRequest());

    apiGetBookmarks(url).then(({ statuses, links }) => {
      dispatch(importFetchedStatuses(statuses));
      dispatch(expandBookmarkedStatusesSuccess(statuses, getNextLinkUri(links)));
    }).catch((error: unknown) => {
      dispatch(expandBookmarkedStatusesFail(error));
    });
  };
}

export function expandBookmarkedStatusesRequest() {
  return {
    type: BOOKMARKED_STATUSES_EXPAND_REQUEST,
  };
}

export function expandBookmarkedStatusesSuccess(statuses: ApiStatusJSON[], next: string | null) {
  return {
    type: BOOKMARKED_STATUSES_EXPAND_SUCCESS,
    statuses,
    next,
  };
}

export function expandBookmarkedStatusesFail(error: unknown) {
  return {
    type: BOOKMARKED_STATUSES_EXPAND_FAIL,
    error,
  };
}
