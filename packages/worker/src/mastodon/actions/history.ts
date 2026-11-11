import type { ApiStatusEditJSON } from '@tstodon/api';
import { apiGetStatusHistory } from 'mastodon/api/statuses';
import type { AppDispatch, GetState } from 'mastodon/store';

import { importFetchedAccounts } from './importer';

export const HISTORY_FETCH_REQUEST = 'HISTORY_FETCH_REQUEST' as const;
export const HISTORY_FETCH_SUCCESS = 'HISTORY_FETCH_SUCCESS' as const;
export const HISTORY_FETCH_FAIL = 'HISTORY_FETCH_FAIL' as const;

export const fetchHistory =
  (statusId: string) => (dispatch: AppDispatch, getState: GetState) => {
    const loading = getState().history.get(statusId)?.get('loading');

    if (loading) {
      return;
    }

    dispatch(fetchHistoryRequest(statusId));

    apiGetStatusHistory(statusId)
      .then((data) => {
        dispatch(importFetchedAccounts(data.map((x) => x.account)));
        dispatch(fetchHistorySuccess(statusId, data));
      })
      .catch((error: unknown) => dispatch(fetchHistoryFail(statusId, error)));
  };

export const fetchHistoryRequest = (statusId: string) => ({
  type: HISTORY_FETCH_REQUEST,
  statusId,
});

export const fetchHistorySuccess = (
  statusId: string,
  history: ApiStatusEditJSON[],
) => ({
  type: HISTORY_FETCH_SUCCESS,
  statusId,
  history,
});

export const fetchHistoryFail = (statusId: string, error: unknown) => ({
  type: HISTORY_FETCH_FAIL,
  statusId,
  error,
});
