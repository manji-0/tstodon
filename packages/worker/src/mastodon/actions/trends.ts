import type {
  ApiGetTrendsParams,
  ApiHashtagJSON,
  ApiStatusJSON,
  ApiTrendsLinkJSON,
} from '@tstodon/api';
import {
  apiGetTrendingLinks,
  apiGetTrendingStatuses,
  apiGetTrendingTags,
} from 'mastodon/api/trends';
import type { AppDispatch, GetState } from 'mastodon/store';

import { importFetchedStatuses, importFetchedAccounts } from './importer';

export const TRENDS_TAGS_FETCH_REQUEST = 'TRENDS_TAGS_FETCH_REQUEST';
export const TRENDS_TAGS_FETCH_SUCCESS = 'TRENDS_TAGS_FETCH_SUCCESS';
export const TRENDS_TAGS_FETCH_FAIL    = 'TRENDS_TAGS_FETCH_FAIL';

export const TRENDS_LINKS_FETCH_REQUEST = 'TRENDS_LINKS_FETCH_REQUEST';
export const TRENDS_LINKS_FETCH_SUCCESS = 'TRENDS_LINKS_FETCH_SUCCESS';
export const TRENDS_LINKS_FETCH_FAIL    = 'TRENDS_LINKS_FETCH_FAIL';

export const TRENDS_STATUSES_FETCH_REQUEST = 'TRENDS_STATUSES_FETCH_REQUEST';
export const TRENDS_STATUSES_FETCH_SUCCESS = 'TRENDS_STATUSES_FETCH_SUCCESS';
export const TRENDS_STATUSES_FETCH_FAIL    = 'TRENDS_STATUSES_FETCH_FAIL';

export const TRENDS_STATUSES_EXPAND_REQUEST = 'TRENDS_STATUSES_EXPAND_REQUEST';
export const TRENDS_STATUSES_EXPAND_SUCCESS = 'TRENDS_STATUSES_EXPAND_SUCCESS';
export const TRENDS_STATUSES_EXPAND_FAIL    = 'TRENDS_STATUSES_EXPAND_FAIL';

export const fetchTrendingHashtags = () => (dispatch: AppDispatch) => {
  dispatch(fetchTrendingHashtagsRequest());

  apiGetTrendingTags()
    .then((data) => dispatch(fetchTrendingHashtagsSuccess(data)))
    .catch((err: unknown) => dispatch(fetchTrendingHashtagsFail(err)));
};

export const fetchTrendingHashtagsRequest = () => ({
  type: TRENDS_TAGS_FETCH_REQUEST,
  skipLoading: true,
});

export const fetchTrendingHashtagsSuccess = (trends: ApiHashtagJSON[]) => ({
  type: TRENDS_TAGS_FETCH_SUCCESS,
  trends,
  skipLoading: true,
});

export const fetchTrendingHashtagsFail = (error: unknown) => ({
  type: TRENDS_TAGS_FETCH_FAIL,
  error,
  skipLoading: true,
  skipAlert: true,
});

export const fetchTrendingLinks = () => (dispatch: AppDispatch) => {
  dispatch(fetchTrendingLinksRequest());

  apiGetTrendingLinks({ limit: 20 } satisfies ApiGetTrendsParams)
    .then((data) => {
      dispatch(importFetchedAccounts(data.flatMap(link => link.authors.map(author => author.account)).filter(account => !!account)));
      dispatch(fetchTrendingLinksSuccess(data));
    })
    .catch((err: unknown) => dispatch(fetchTrendingLinksFail(err)));
};

export const fetchTrendingLinksRequest = () => ({
  type: TRENDS_LINKS_FETCH_REQUEST,
  skipLoading: true,
});

export const fetchTrendingLinksSuccess = (trends: ApiTrendsLinkJSON[]) => ({
  type: TRENDS_LINKS_FETCH_SUCCESS,
  trends,
  skipLoading: true,
});

export const fetchTrendingLinksFail = (error: unknown) => ({
  type: TRENDS_LINKS_FETCH_FAIL,
  error,
  skipLoading: true,
  skipAlert: true,
});

export const fetchTrendingStatuses = () => (dispatch: AppDispatch, getState: GetState) => {
  if (getState().status_lists.getIn(['trending', 'isLoading'])) {
    return;
  }

  dispatch(fetchTrendingStatusesRequest());

  apiGetTrendingStatuses().then(({ statuses, next }) => {
    dispatch(importFetchedStatuses(statuses));
    dispatch(fetchTrendingStatusesSuccess(statuses, next ?? null));
  }).catch((err: unknown) => dispatch(fetchTrendingStatusesFail(err)));
};

export const fetchTrendingStatusesRequest = () => ({
  type: TRENDS_STATUSES_FETCH_REQUEST,
  skipLoading: true,
});

export const fetchTrendingStatusesSuccess = (statuses: ApiStatusJSON[], next: string | null) => ({
  type: TRENDS_STATUSES_FETCH_SUCCESS,
  statuses,
  next,
  skipLoading: true,
});

export const fetchTrendingStatusesFail = (error: unknown) => ({
  type: TRENDS_STATUSES_FETCH_FAIL,
  error,
  skipLoading: true,
  skipAlert: true,
});


export const expandTrendingStatuses = () => (dispatch: AppDispatch, getState: GetState) => {
  const url = getState().status_lists.getIn(['trending', 'next'], null);

  if (typeof url !== 'string' || getState().status_lists.getIn(['trending', 'isLoading'])) {
    return;
  }

  dispatch(expandTrendingStatusesRequest());

  apiGetTrendingStatuses(url).then(({ statuses, next }) => {
    dispatch(importFetchedStatuses(statuses));
    dispatch(expandTrendingStatusesSuccess(statuses, next ?? null));
  }).catch((error: unknown) => {
    dispatch(expandTrendingStatusesFail(error));
  });
};

export const expandTrendingStatusesRequest = () => ({
  type: TRENDS_STATUSES_EXPAND_REQUEST,
});

export const expandTrendingStatusesSuccess = (statuses: ApiStatusJSON[], next: string | null) => ({
  type: TRENDS_STATUSES_EXPAND_SUCCESS,
  statuses,
  next,
});

export const expandTrendingStatusesFail = (error: unknown) => ({
  type: TRENDS_STATUSES_EXPAND_FAIL,
  error,
});
