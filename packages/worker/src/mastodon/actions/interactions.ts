import { getNextLinkUri } from 'mastodon/api';
import {
  apiGetStatusFavouritedBy,
  apiGetStatusRebloggedBy,
} from 'mastodon/api/accounts';
import {
  apiBookmark,
  apiFavourite,
  apiPin,
  apiUnbookmark,
  apiUnfavourite,
  apiUnpin,
} from 'mastodon/api/interactions';
import type { ApiAccountJSON } from 'mastodon/api_types/accounts';
import type { ApiStatusJSON } from 'mastodon/api_types/statuses';
import { boostModal } from 'mastodon/initial_state';
import type { Status, StatusVisibility } from 'mastodon/models/status';
import type { AppDispatch, GetState } from 'mastodon/store';

import { fetchRelationships } from './accounts';
import { importFetchedAccounts, importFetchedStatus } from './importer';
import { unreblog, reblog } from './interactions_typed';
import { openModal } from './modal';
import {
  insertPinnedStatusIntoTimelines,
  removePinnedStatusFromTimelines,
} from './timelines_typed';

export const REBLOGS_EXPAND_REQUEST = 'REBLOGS_EXPAND_REQUEST' as const;
export const REBLOGS_EXPAND_SUCCESS = 'REBLOGS_EXPAND_SUCCESS' as const;
export const REBLOGS_EXPAND_FAIL = 'REBLOGS_EXPAND_FAIL' as const;

export const FAVOURITE_REQUEST = 'FAVOURITE_REQUEST' as const;
export const FAVOURITE_SUCCESS = 'FAVOURITE_SUCCESS' as const;
export const FAVOURITE_FAIL    = 'FAVOURITE_FAIL' as const;

export const UNFAVOURITE_REQUEST = 'UNFAVOURITE_REQUEST' as const;
export const UNFAVOURITE_SUCCESS = 'UNFAVOURITE_SUCCESS' as const;
export const UNFAVOURITE_FAIL    = 'UNFAVOURITE_FAIL' as const;

export const REBLOGS_FETCH_REQUEST = 'REBLOGS_FETCH_REQUEST' as const;
export const REBLOGS_FETCH_SUCCESS = 'REBLOGS_FETCH_SUCCESS' as const;
export const REBLOGS_FETCH_FAIL    = 'REBLOGS_FETCH_FAIL' as const;

export const FAVOURITES_FETCH_REQUEST = 'FAVOURITES_FETCH_REQUEST' as const;
export const FAVOURITES_FETCH_SUCCESS = 'FAVOURITES_FETCH_SUCCESS' as const;
export const FAVOURITES_FETCH_FAIL    = 'FAVOURITES_FETCH_FAIL' as const;

export const FAVOURITES_EXPAND_REQUEST = 'FAVOURITES_EXPAND_REQUEST' as const;
export const FAVOURITES_EXPAND_SUCCESS = 'FAVOURITES_EXPAND_SUCCESS' as const;
export const FAVOURITES_EXPAND_FAIL = 'FAVOURITES_EXPAND_FAIL' as const;

export const PIN_REQUEST = 'PIN_REQUEST';
export const PIN_SUCCESS = 'PIN_SUCCESS' as const;
export const PIN_FAIL    = 'PIN_FAIL';

export const UNPIN_REQUEST = 'UNPIN_REQUEST';
export const UNPIN_SUCCESS = 'UNPIN_SUCCESS' as const;
export const UNPIN_FAIL    = 'UNPIN_FAIL';

export const BOOKMARK_REQUEST = 'BOOKMARK_REQUEST' as const;
export const BOOKMARK_SUCCESS = 'BOOKMARKED_SUCCESS' as const;
export const BOOKMARK_FAIL    = 'BOOKMARKED_FAIL' as const;

export const UNBOOKMARK_REQUEST = 'UNBOOKMARKED_REQUEST' as const;
export const UNBOOKMARK_SUCCESS = 'UNBOOKMARKED_SUCCESS' as const;
export const UNBOOKMARK_FAIL    = 'UNBOOKMARKED_FAIL' as const;

export * from './interactions_typed';

export function favourite(status: Status) {
  return function (dispatch: AppDispatch) {
    dispatch(favouriteRequest(status));

    apiFavourite(status.get('id') as string).then(function (data) {
      dispatch(importFetchedStatus(data));
      dispatch(favouriteSuccess(status));
    }).catch(function (error: unknown) {
      dispatch(favouriteFail(status, error));
    });
  };
}

export function unfavourite(status: Status) {
  return (dispatch: AppDispatch) => {
    dispatch(unfavouriteRequest(status));

    apiUnfavourite(status.get('id') as string).then(data => {
      dispatch(importFetchedStatus(data));
      dispatch(unfavouriteSuccess(status));
    }).catch((error: unknown) => {
      dispatch(unfavouriteFail(status, error));
    });
  };
}

export function favouriteRequest(status: Status) {
  return {
    type: FAVOURITE_REQUEST,
    status: status,
    skipLoading: true,
  };
}

export function favouriteSuccess(status: Status) {
  return {
    type: FAVOURITE_SUCCESS,
    status: status,
    skipLoading: true,
  };
}

export function favouriteFail(status: Status, error: unknown) {
  return {
    type: FAVOURITE_FAIL,
    status: status,
    error: error,
    skipLoading: true,
  };
}

export function unfavouriteRequest(status: Status) {
  return {
    type: UNFAVOURITE_REQUEST,
    status: status,
    skipLoading: true,
  };
}

export function unfavouriteSuccess(status: Status) {
  return {
    type: UNFAVOURITE_SUCCESS,
    status: status,
    skipLoading: true,
  };
}

export function unfavouriteFail(status: Status, error: unknown) {
  return {
    type: UNFAVOURITE_FAIL,
    status: status,
    error: error,
    skipLoading: true,
  };
}

export function bookmark(status: Status) {
  return function (dispatch: AppDispatch) {
    dispatch(bookmarkRequest(status));

    apiBookmark(status.get('id') as string).then(function (data) {
      dispatch(importFetchedStatus(data));
      dispatch(bookmarkSuccess(status, data));
    }).catch(function (error: unknown) {
      dispatch(bookmarkFail(status, error));
    });
  };
}

export function unbookmark(status: Status) {
  return (dispatch: AppDispatch) => {
    dispatch(unbookmarkRequest(status));

    apiUnbookmark(status.get('id') as string).then(data => {
      dispatch(importFetchedStatus(data));
      dispatch(unbookmarkSuccess(status, data));
    }).catch((error: unknown) => {
      dispatch(unbookmarkFail(status, error));
    });
  };
}

export function bookmarkRequest(status: Status) {
  return {
    type: BOOKMARK_REQUEST,
    status: status,
  };
}

export function bookmarkSuccess(status: Status, response: ApiStatusJSON) {
  return {
    type: BOOKMARK_SUCCESS,
    status: status,
    response: response,
  };
}

export function bookmarkFail(status: Status, error: unknown) {
  return {
    type: BOOKMARK_FAIL,
    status: status,
    error: error,
  };
}

export function unbookmarkRequest(status: Status) {
  return {
    type: UNBOOKMARK_REQUEST,
    status: status,
  };
}

export function unbookmarkSuccess(status: Status, response: ApiStatusJSON) {
  return {
    type: UNBOOKMARK_SUCCESS,
    status: status,
    response: response,
  };
}

export function unbookmarkFail(status: Status, error: unknown) {
  return {
    type: UNBOOKMARK_FAIL,
    status: status,
    error: error,
  };
}

export function fetchReblogs(id: string) {
  return (dispatch: AppDispatch) => {
    dispatch(fetchReblogsRequest(id));

    apiGetStatusRebloggedBy(id).then(({ accounts, links }) => {
      dispatch(importFetchedAccounts(accounts));
      dispatch(fetchReblogsSuccess(id, accounts, getNextLinkUri(links)));
      dispatch(fetchRelationships(accounts.map(item => item.id)));
    }).catch((error: unknown) => {
      dispatch(fetchReblogsFail(id, error));
    });
  };
}

export function fetchReblogsRequest(id: string) {
  return {
    type: REBLOGS_FETCH_REQUEST,
    id,
  };
}

export function fetchReblogsSuccess(id: string, accounts: ApiAccountJSON[], next: string | null) {
  return {
    type: REBLOGS_FETCH_SUCCESS,
    id,
    accounts,
    next,
  };
}

export function fetchReblogsFail(id: string, error: unknown) {
  return {
    type: REBLOGS_FETCH_FAIL,
    id,
    error,
  };
}

export function expandReblogs(id: string) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const url = getState().user_lists.getIn(['reblogged_by', id, 'next']);
    if (typeof url !== 'string') {
      return;
    }

    dispatch(expandReblogsRequest(id));

    apiGetStatusRebloggedBy(id, url).then(({ accounts, links }) => {
      dispatch(importFetchedAccounts(accounts));
      dispatch(expandReblogsSuccess(id, accounts, getNextLinkUri(links)));
      dispatch(fetchRelationships(accounts.map(item => item.id)));
    }).catch((error: unknown) => dispatch(expandReblogsFail(id, error)));
  };
}

export function expandReblogsRequest(id: string) {
  return {
    type: REBLOGS_EXPAND_REQUEST,
    id,
  };
}

export function expandReblogsSuccess(id: string, accounts: ApiAccountJSON[], next: string | null) {
  return {
    type: REBLOGS_EXPAND_SUCCESS,
    id,
    accounts,
    next,
  };
}

export function expandReblogsFail(id: string, error: unknown) {
  return {
    type: REBLOGS_EXPAND_FAIL,
    id,
    error,
  };
}

export function fetchFavourites(id: string) {
  return (dispatch: AppDispatch) => {
    dispatch(fetchFavouritesRequest(id));

    apiGetStatusFavouritedBy(id).then(({ accounts, links }) => {
      dispatch(importFetchedAccounts(accounts));
      dispatch(fetchFavouritesSuccess(id, accounts, getNextLinkUri(links)));
      dispatch(fetchRelationships(accounts.map(item => item.id)));
    }).catch((error: unknown) => {
      dispatch(fetchFavouritesFail(id, error));
    });
  };
}

export function fetchFavouritesRequest(id: string) {
  return {
    type: FAVOURITES_FETCH_REQUEST,
    id,
  };
}

export function fetchFavouritesSuccess(id: string, accounts: ApiAccountJSON[], next: string | null) {
  return {
    type: FAVOURITES_FETCH_SUCCESS,
    id,
    accounts,
    next,
  };
}

export function fetchFavouritesFail(id: string, error: unknown) {
  return {
    type: FAVOURITES_FETCH_FAIL,
    id,
    error,
  };
}

export function expandFavourites(id: string) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const url = getState().user_lists.getIn(['favourited_by', id, 'next']);
    if (typeof url !== 'string') {
      return;
    }

    dispatch(expandFavouritesRequest(id));

    apiGetStatusFavouritedBy(id, url).then(({ accounts, links }) => {
      dispatch(importFetchedAccounts(accounts));
      dispatch(expandFavouritesSuccess(id, accounts, getNextLinkUri(links)));
      dispatch(fetchRelationships(accounts.map(item => item.id)));
    }).catch((error: unknown) => dispatch(expandFavouritesFail(id, error)));
  };
}

export function expandFavouritesRequest(id: string) {
  return {
    type: FAVOURITES_EXPAND_REQUEST,
    id,
  };
}

export function expandFavouritesSuccess(id: string, accounts: ApiAccountJSON[], next: string | null) {
  return {
    type: FAVOURITES_EXPAND_SUCCESS,
    id,
    accounts,
    next,
  };
}

export function expandFavouritesFail(id: string, error: unknown) {
  return {
    type: FAVOURITES_EXPAND_FAIL,
    id,
    error,
  };
}

export function pin(status: Status) {
  return (dispatch: AppDispatch) => {
    dispatch(pinRequest(status));

    apiPin(status.get('id') as string).then(data => {
      dispatch(importFetchedStatus(data));
      dispatch(pinSuccess(status));
      dispatch(insertPinnedStatusIntoTimelines(status));
    }).catch((error: unknown) => {
      dispatch(pinFail(status, error));
    });
  };
}

export function pinRequest(status: Status) {
  return {
    type: PIN_REQUEST,
    status,
    skipLoading: true,
  };
}

export function pinSuccess(status: Status) {
  return {
    type: PIN_SUCCESS,
    status,
    skipLoading: true,
  };
}

export function pinFail(status: Status, error: unknown) {
  return {
    type: PIN_FAIL,
    status,
    error,
    skipLoading: true,
  };
}

export function unpin (status: Status) {
  return (dispatch: AppDispatch) => {
    dispatch(unpinRequest(status));

    apiUnpin(status.get('id') as string).then(data => {
      dispatch(importFetchedStatus(data));
      dispatch(unpinSuccess(status));
      dispatch(removePinnedStatusFromTimelines(status));
    }).catch((error: unknown) => {
      dispatch(unpinFail(status, error));
    });
  };
}

export function unpinRequest(status: Status) {
  return {
    type: UNPIN_REQUEST,
    status,
    skipLoading: true,
  };
}

export function unpinSuccess(status: Status) {
  return {
    type: UNPIN_SUCCESS,
    status,
    skipLoading: true,
  };
}

export function unpinFail(status: Status, error: unknown) {
  return {
    type: UNPIN_FAIL,
    status,
    error,
    skipLoading: true,
  };
}

function toggleReblogWithoutConfirmation(status: Status, visibility?: StatusVisibility) {
  return (dispatch: AppDispatch) => {
    const statusId = status.get('id') as string;

    if (status.get('reblogged')) {
      void dispatch(unreblog({ statusId }));
    } else {
      void dispatch(reblog({ statusId, visibility }));
    }
  };
}

export function toggleReblog(statusId: string, skipModal = false) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const state = getState();
    let status = state.statuses.get(statusId);

    if (!status)
      return;

    // The reblog modal expects a pre-filled account in status
    // TODO: fix this by having the reblog modal get a statusId and do the work itself
    status = status.set('account', state.accounts.get(status.get('account') as string));

    if (boostModal && !skipModal) {
      dispatch(openModal({ modalType: 'BOOST', modalProps: { status, onReblog: (status: Status, privacy: StatusVisibility) => { dispatch(toggleReblogWithoutConfirmation(status, privacy)); } } }));
    } else {
      dispatch(toggleReblogWithoutConfirmation(status));
    }
  };
}

export function toggleFavourite(statusId: string) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const state = getState();
    const status = state.statuses.get(statusId);

    if (!status)
      return;

    if (status.get('favourited')) {
      dispatch(unfavourite(status));
    } else {
      dispatch(favourite(status));
    }
  };
}
