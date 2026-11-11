import { getNextLinkUri } from 'mastodon/api';
import { apiGetFavourites } from 'mastodon/api/interactions';
import type { ApiStatusJSON } from 'mastodon/api_types/statuses';
import type { AppDispatch, GetState } from 'mastodon/store';

import { importFetchedStatuses } from './importer';

export const FAVOURITED_STATUSES_FETCH_REQUEST = 'FAVOURITED_STATUSES_FETCH_REQUEST' as const;
export const FAVOURITED_STATUSES_FETCH_SUCCESS = 'FAVOURITED_STATUSES_FETCH_SUCCESS' as const;
export const FAVOURITED_STATUSES_FETCH_FAIL    = 'FAVOURITED_STATUSES_FETCH_FAIL' as const;

export const FAVOURITED_STATUSES_EXPAND_REQUEST = 'FAVOURITED_STATUSES_EXPAND_REQUEST' as const;
export const FAVOURITED_STATUSES_EXPAND_SUCCESS = 'FAVOURITED_STATUSES_EXPAND_SUCCESS' as const;
export const FAVOURITED_STATUSES_EXPAND_FAIL    = 'FAVOURITED_STATUSES_EXPAND_FAIL' as const;

export function fetchFavouritedStatuses() {
  return (dispatch: AppDispatch, getState: GetState) => {
    if (getState().status_lists.getIn(['favourites', 'isLoading'])) {
      return;
    }

    dispatch(fetchFavouritedStatusesRequest());

    apiGetFavourites().then(({ statuses, links }) => {
      dispatch(importFetchedStatuses(statuses));
      dispatch(fetchFavouritedStatusesSuccess(statuses, getNextLinkUri(links)));
    }).catch((error: unknown) => {
      dispatch(fetchFavouritedStatusesFail(error));
    });
  };
}

export function fetchFavouritedStatusesRequest() {
  return {
    type: FAVOURITED_STATUSES_FETCH_REQUEST,
    skipLoading: true,
  };
}

export function fetchFavouritedStatusesSuccess(statuses: ApiStatusJSON[], next: string | null) {
  return {
    type: FAVOURITED_STATUSES_FETCH_SUCCESS,
    statuses,
    next,
    skipLoading: true,
  };
}

export function fetchFavouritedStatusesFail(error: unknown) {
  return {
    type: FAVOURITED_STATUSES_FETCH_FAIL,
    error,
    skipLoading: true,
  };
}

export function expandFavouritedStatuses() {
  return (dispatch: AppDispatch, getState: GetState) => {
    const url = getState().status_lists.getIn(['favourites', 'next'], null);

    if (typeof url !== 'string' || getState().status_lists.getIn(['favourites', 'isLoading'])) {
      return;
    }

    dispatch(expandFavouritedStatusesRequest());

    apiGetFavourites(url).then(({ statuses, links }) => {
      dispatch(importFetchedStatuses(statuses));
      dispatch(expandFavouritedStatusesSuccess(statuses, getNextLinkUri(links)));
    }).catch((error: unknown) => {
      dispatch(expandFavouritedStatusesFail(error));
    });
  };
}

export function expandFavouritedStatusesRequest() {
  return {
    type: FAVOURITED_STATUSES_EXPAND_REQUEST,
  };
}

export function expandFavouritedStatusesSuccess(statuses: ApiStatusJSON[], next: string | null) {
  return {
    type: FAVOURITED_STATUSES_EXPAND_SUCCESS,
    statuses,
    next,
  };
}

export function expandFavouritedStatusesFail(error: unknown) {
  return {
    type: FAVOURITED_STATUSES_EXPAND_FAIL,
    error,
  };
}
