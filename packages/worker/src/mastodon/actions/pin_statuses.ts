import { apiGetAccountStatuses } from 'mastodon/api/accounts';
import type { ApiStatusJSON } from 'mastodon/api_types/statuses';
import type { AppDispatch } from 'mastodon/store';

import { me } from '../initial_state';

import { importFetchedStatuses } from './importer';

export const PINNED_STATUSES_FETCH_REQUEST = 'PINNED_STATUSES_FETCH_REQUEST';
export const PINNED_STATUSES_FETCH_SUCCESS = 'PINNED_STATUSES_FETCH_SUCCESS';
export const PINNED_STATUSES_FETCH_FAIL = 'PINNED_STATUSES_FETCH_FAIL';

export function fetchPinnedStatuses() {
  return (dispatch: AppDispatch) => {
    if (!me) {
      return;
    }

    dispatch(fetchPinnedStatusesRequest());

    apiGetAccountStatuses(me, { pinned: true }).then(statuses => {
      dispatch(importFetchedStatuses(statuses));
      dispatch(fetchPinnedStatusesSuccess(statuses, null));
    }).catch((error: unknown) => {
      dispatch(fetchPinnedStatusesFail(error));
    });
  };
}

export function fetchPinnedStatusesRequest() {
  return {
    type: PINNED_STATUSES_FETCH_REQUEST,
  };
}

export function fetchPinnedStatusesSuccess(statuses: ApiStatusJSON[], next: string | null) {
  return {
    type: PINNED_STATUSES_FETCH_SUCCESS,
    statuses,
    next,
  };
}

export function fetchPinnedStatusesFail(error: unknown) {
  return {
    type: PINNED_STATUSES_FETCH_FAIL,
    error,
  };
}
