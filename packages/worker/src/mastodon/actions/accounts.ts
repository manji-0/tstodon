import type { ApiFollowAccountParams } from '@tstodon/api';
import { getNextLinkUri } from 'mastodon/api';
import {
  apiAuthorizeFollowRequest,
  apiBlockAccount,
  apiEndorseAccount,
  apiFollowAccount,
  apiGetAccount,
  apiGetFollowRequests,
  apiGetFollowers,
  apiGetFollowing,
  apiGetRelationships,
  apiLookupAccount,
  apiMuteAccount,
  apiRejectFollowRequest,
  apiUnblockAccount,
  apiUnendorseAccount,
  apiUnfollowAccount,
  apiUnmuteAccount,
  apiUpdateCredentials,
} from 'mastodon/api/accounts';
import type { ApiAccountJSON } from 'mastodon/api_types/accounts';
import { browserHistory } from 'mastodon/components/router';
import type { AppDispatch, GetState } from 'mastodon/store';
import { debounceWithDispatchAndArguments } from 'mastodon/utils/debounce';

import { me } from '../initial_state';

import {
  followAccountSuccess, unfollowAccountSuccess,
  authorizeFollowRequestSuccess, rejectFollowRequestSuccess,
  followAccountRequest, followAccountFail,
  unfollowAccountRequest, unfollowAccountFail,
  muteAccountSuccess, unmuteAccountSuccess,
  blockAccountSuccess, unblockAccountSuccess,
  pinAccountSuccess, unpinAccountSuccess,
  fetchRelationshipsSuccess,
  fetchEndorsedAccounts,
} from './accounts_typed';
import { importFetchedAccount, importFetchedAccounts } from './importer';

export const ACCOUNT_FETCH_REQUEST = 'ACCOUNT_FETCH_REQUEST';
export const ACCOUNT_FETCH_SUCCESS = 'ACCOUNT_FETCH_SUCCESS';
export const ACCOUNT_FETCH_FAIL    = 'ACCOUNT_FETCH_FAIL';

export const ACCOUNT_LOOKUP_REQUEST = 'ACCOUNT_LOOKUP_REQUEST';
export const ACCOUNT_LOOKUP_SUCCESS = 'ACCOUNT_LOOKUP_SUCCESS';
export const ACCOUNT_LOOKUP_FAIL    = 'ACCOUNT_LOOKUP_FAIL';

export const ACCOUNT_BLOCK_REQUEST = 'ACCOUNT_BLOCK_REQUEST';
export const ACCOUNT_BLOCK_FAIL    = 'ACCOUNT_BLOCK_FAIL';

export const ACCOUNT_UNBLOCK_REQUEST = 'ACCOUNT_UNBLOCK_REQUEST';
export const ACCOUNT_UNBLOCK_FAIL    = 'ACCOUNT_UNBLOCK_FAIL';

export const ACCOUNT_MUTE_REQUEST = 'ACCOUNT_MUTE_REQUEST';
export const ACCOUNT_MUTE_FAIL    = 'ACCOUNT_MUTE_FAIL';

export const ACCOUNT_UNMUTE_REQUEST = 'ACCOUNT_UNMUTE_REQUEST';
export const ACCOUNT_UNMUTE_FAIL    = 'ACCOUNT_UNMUTE_FAIL';

export const ACCOUNT_PIN_REQUEST = 'ACCOUNT_PIN_REQUEST';
export const ACCOUNT_PIN_FAIL    = 'ACCOUNT_PIN_FAIL';

export const ACCOUNT_UNPIN_REQUEST = 'ACCOUNT_UNPIN_REQUEST';
export const ACCOUNT_UNPIN_FAIL    = 'ACCOUNT_UNPIN_FAIL';

export const FOLLOWERS_FETCH_REQUEST = 'FOLLOWERS_FETCH_REQUEST' as const;
export const FOLLOWERS_FETCH_SUCCESS = 'FOLLOWERS_FETCH_SUCCESS' as const;
export const FOLLOWERS_FETCH_FAIL    = 'FOLLOWERS_FETCH_FAIL' as const;

export const FOLLOWERS_EXPAND_REQUEST = 'FOLLOWERS_EXPAND_REQUEST' as const;
export const FOLLOWERS_EXPAND_SUCCESS = 'FOLLOWERS_EXPAND_SUCCESS' as const;
export const FOLLOWERS_EXPAND_FAIL    = 'FOLLOWERS_EXPAND_FAIL' as const;

export const FOLLOWING_FETCH_REQUEST = 'FOLLOWING_FETCH_REQUEST' as const;
export const FOLLOWING_FETCH_SUCCESS = 'FOLLOWING_FETCH_SUCCESS' as const;
export const FOLLOWING_FETCH_FAIL    = 'FOLLOWING_FETCH_FAIL' as const;

export const FOLLOWING_EXPAND_REQUEST = 'FOLLOWING_EXPAND_REQUEST' as const;
export const FOLLOWING_EXPAND_SUCCESS = 'FOLLOWING_EXPAND_SUCCESS' as const;
export const FOLLOWING_EXPAND_FAIL    = 'FOLLOWING_EXPAND_FAIL' as const;

export const RELATIONSHIPS_FETCH_REQUEST = 'RELATIONSHIPS_FETCH_REQUEST';
export const RELATIONSHIPS_FETCH_FAIL    = 'RELATIONSHIPS_FETCH_FAIL';

export const FOLLOW_REQUESTS_FETCH_REQUEST = 'FOLLOW_REQUESTS_FETCH_REQUEST' as const;
export const FOLLOW_REQUESTS_FETCH_SUCCESS = 'FOLLOW_REQUESTS_FETCH_SUCCESS' as const;
export const FOLLOW_REQUESTS_FETCH_FAIL    = 'FOLLOW_REQUESTS_FETCH_FAIL' as const;

export const FOLLOW_REQUESTS_EXPAND_REQUEST = 'FOLLOW_REQUESTS_EXPAND_REQUEST' as const;
export const FOLLOW_REQUESTS_EXPAND_SUCCESS = 'FOLLOW_REQUESTS_EXPAND_SUCCESS' as const;
export const FOLLOW_REQUESTS_EXPAND_FAIL    = 'FOLLOW_REQUESTS_EXPAND_FAIL' as const;

export const FOLLOW_REQUEST_AUTHORIZE_REQUEST = 'FOLLOW_REQUEST_AUTHORIZE_REQUEST';
export const FOLLOW_REQUEST_AUTHORIZE_FAIL    = 'FOLLOW_REQUEST_AUTHORIZE_FAIL';

export const FOLLOW_REQUEST_REJECT_REQUEST = 'FOLLOW_REQUEST_REJECT_REQUEST';
export const FOLLOW_REQUEST_REJECT_FAIL    = 'FOLLOW_REQUEST_REJECT_FAIL';

export const ACCOUNT_REVEAL = 'ACCOUNT_REVEAL';

export * from './accounts_typed';

export function fetchAccount(id: string) {
  return (dispatch: AppDispatch) => {
    dispatch(fetchRelationships([id]));
    dispatch(fetchAccountRequest(id));

    apiGetAccount(id).then(account => {
      dispatch(importFetchedAccount(account));
      dispatch(fetchAccountSuccess());
    }).catch((error: unknown) => {
      dispatch(fetchAccountFail(id, error));
    });
  };
}

export const lookupAccount = (acct: string) => (dispatch: AppDispatch) => {
  dispatch(lookupAccountRequest(acct));

  apiLookupAccount(acct).then(account => {
    dispatch(fetchRelationships([account.id]));
    dispatch(importFetchedAccount(account));
    dispatch(lookupAccountSuccess());
  }).catch((error: unknown) => {
    dispatch(lookupAccountFail(acct, error));
  });
};

export const lookupAccountRequest = (acct: string) => ({
  type: ACCOUNT_LOOKUP_REQUEST,
  acct,
});

export const lookupAccountSuccess = () => ({
  type: ACCOUNT_LOOKUP_SUCCESS,
});

export const lookupAccountFail = (acct: string, error: unknown) => ({
  type: ACCOUNT_LOOKUP_FAIL,
  acct,
  error,
  skipAlert: true,
});

export function fetchAccountRequest(id: string) {
  return {
    type: ACCOUNT_FETCH_REQUEST,
    id,
  };
}

export function fetchAccountSuccess() {
  return {
    type: ACCOUNT_FETCH_SUCCESS,
  };
}

export function fetchAccountFail(id: string, error: unknown) {
  return {
    type: ACCOUNT_FETCH_FAIL,
    id,
    error,
    skipAlert: true,
  };
}

export function followAccount(id: string, options: ApiFollowAccountParams = { reblogs: true }) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const relationship = getState().relationships.get(id);
    const alreadyFollowing = !!(relationship?.following || relationship?.requested);
    const locked = getState().accounts.get(id)?.locked ?? false;

    dispatch(followAccountRequest({ id, locked }));

    apiFollowAccount(id, options).then(relationship => {
      dispatch(followAccountSuccess({relationship, alreadyFollowing}));
    }).catch((error: unknown) => {
      dispatch(followAccountFail({ id, error, locked }));
    });
  };
}

export function unfollowAccount(id: string) {
  return (dispatch: AppDispatch, getState: GetState) => {
    dispatch(unfollowAccountRequest({ id }));

    apiUnfollowAccount(id).then(relationship => {
      dispatch(unfollowAccountSuccess({relationship, statuses: getState().statuses}));
    }).catch((error: unknown) => {
      dispatch(unfollowAccountFail({ id, error }));
    });
  };
}

export function blockAccount(id: string) {
  return (dispatch: AppDispatch, getState: GetState) => {
    dispatch(blockAccountRequest(id));

    apiBlockAccount(id).then(relationship => {
      // Pass in entire statuses map so we can use it to filter stuff in different parts of the reducers
      dispatch(blockAccountSuccess({ relationship, statuses: getState().statuses }));
    }).catch((error: unknown) => {
      dispatch(blockAccountFail(error));
    });
  };
}

export function unblockAccount(id: string) {
  return (dispatch: AppDispatch) => {
    dispatch(unblockAccountRequest(id));

    apiUnblockAccount(id).then(relationship => {
      dispatch(unblockAccountSuccess({ relationship }));
    }).catch((error: unknown) => {
      dispatch(unblockAccountFail(error));
    });
  };
}

export function blockAccountRequest(id: string) {
  return {
    type: ACCOUNT_BLOCK_REQUEST,
    id,
  };
}
export function blockAccountFail(error: unknown) {
  return {
    type: ACCOUNT_BLOCK_FAIL,
    error,
  };
}

export function unblockAccountRequest(id: string) {
  return {
    type: ACCOUNT_UNBLOCK_REQUEST,
    id,
  };
}

export function unblockAccountFail(error: unknown) {
  return {
    type: ACCOUNT_UNBLOCK_FAIL,
    error,
  };
}


/**
 * @param notifications also hide the account's notifications (the server's default)
 * @param duration seconds until the mute expires; 0 never expires
 */
export function muteAccount(id: string, notifications?: boolean, duration = 0) {
  return (dispatch: AppDispatch, getState: GetState) => {
    dispatch(muteAccountRequest(id));

    apiMuteAccount(id, { notifications, duration }).then(relationship => {
      // Pass in entire statuses map so we can use it to filter stuff in different parts of the reducers
      dispatch(muteAccountSuccess({ relationship, statuses: getState().statuses }));
    }).catch((error: unknown) => {
      dispatch(muteAccountFail(error));
    });
  };
}

export function unmuteAccount(id: string) {
  return (dispatch: AppDispatch) => {
    dispatch(unmuteAccountRequest(id));

    apiUnmuteAccount(id).then(relationship => {
      dispatch(unmuteAccountSuccess({ relationship }));
    }).catch((error: unknown) => {
      dispatch(unmuteAccountFail(error));
    });
  };
}

export function muteAccountRequest(id: string) {
  return {
    type: ACCOUNT_MUTE_REQUEST,
    id,
  };
}

export function muteAccountFail(error: unknown) {
  return {
    type: ACCOUNT_MUTE_FAIL,
    error,
  };
}

export function unmuteAccountRequest(id: string) {
  return {
    type: ACCOUNT_UNMUTE_REQUEST,
    id,
  };
}

export function unmuteAccountFail(error: unknown) {
  return {
    type: ACCOUNT_UNMUTE_FAIL,
    error,
  };
}


export function fetchFollowers(id: string) {
  return (dispatch: AppDispatch) => {
    dispatch(fetchFollowersRequest(id));

    apiGetFollowers(id).then(({ accounts, links }) => {
      dispatch(importFetchedAccounts(accounts));
      dispatch(fetchFollowersSuccess(id, accounts, getNextLinkUri(links)));
      dispatch(fetchRelationships(accounts.map(item => item.id)));
    }).catch((error: unknown) => {
      dispatch(fetchFollowersFail(id, error));
    });
  };
}

export function fetchFollowersRequest(id: string) {
  return {
    type: FOLLOWERS_FETCH_REQUEST,
    id,
  };
}

export function fetchFollowersSuccess(id: string, accounts: ApiAccountJSON[], next: string | null) {
  return {
    type: FOLLOWERS_FETCH_SUCCESS,
    id,
    accounts,
    next,
  };
}

export function fetchFollowersFail(id: string, error: unknown) {
  return {
    type: FOLLOWERS_FETCH_FAIL,
    id,
    error,
    skipNotFound: true,
  };
}

export function expandFollowers(id: string) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const url = getState().user_lists.getIn(['followers', id, 'next']);

    if (typeof url !== 'string') {
      return;
    }

    dispatch(expandFollowersRequest(id));

    apiGetFollowers(id, url).then(({ accounts, links }) => {
      dispatch(importFetchedAccounts(accounts));
      dispatch(expandFollowersSuccess(id, accounts, getNextLinkUri(links)));
      dispatch(fetchRelationships(accounts.map(item => item.id)));
    }).catch((error: unknown) => {
      dispatch(expandFollowersFail(id, error));
    });
  };
}

export function expandFollowersRequest(id: string) {
  return {
    type: FOLLOWERS_EXPAND_REQUEST,
    id,
  };
}

export function expandFollowersSuccess(id: string, accounts: ApiAccountJSON[], next: string | null) {
  return {
    type: FOLLOWERS_EXPAND_SUCCESS,
    id,
    accounts,
    next,
  };
}

export function expandFollowersFail(id: string, error: unknown) {
  return {
    type: FOLLOWERS_EXPAND_FAIL,
    id,
    error,
  };
}

export function fetchFollowing(id: string) {
  return (dispatch: AppDispatch) => {
    dispatch(fetchFollowingRequest(id));

    apiGetFollowing(id).then(({ accounts, links }) => {
      dispatch(importFetchedAccounts(accounts));
      dispatch(fetchFollowingSuccess(id, accounts, getNextLinkUri(links)));
      dispatch(fetchRelationships(accounts.map(item => item.id)));
    }).catch((error: unknown) => {
      dispatch(fetchFollowingFail(id, error));
    });
  };
}

export function fetchFollowingRequest(id: string) {
  return {
    type: FOLLOWING_FETCH_REQUEST,
    id,
  };
}

export function fetchFollowingSuccess(id: string, accounts: ApiAccountJSON[], next: string | null) {
  return {
    type: FOLLOWING_FETCH_SUCCESS,
    id,
    accounts,
    next,
  };
}

export function fetchFollowingFail(id: string, error: unknown) {
  return {
    type: FOLLOWING_FETCH_FAIL,
    id,
    error,
    skipNotFound: true,
  };
}

export function expandFollowing(id: string) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const url = getState().user_lists.getIn(['following', id, 'next']);

    if (typeof url !== 'string') {
      return;
    }

    dispatch(expandFollowingRequest(id));

    apiGetFollowing(id, url).then(({ accounts, links }) => {
      dispatch(importFetchedAccounts(accounts));
      dispatch(expandFollowingSuccess(id, accounts, getNextLinkUri(links)));
      dispatch(fetchRelationships(accounts.map(item => item.id)));
    }).catch((error: unknown) => {
      dispatch(expandFollowingFail(id, error));
    });
  };
}

export function expandFollowingRequest(id: string) {
  return {
    type: FOLLOWING_EXPAND_REQUEST,
    id,
  };
}

export function expandFollowingSuccess(id: string, accounts: ApiAccountJSON[], next: string | null) {
  return {
    type: FOLLOWING_EXPAND_SUCCESS,
    id,
    accounts,
    next,
  };
}

export function expandFollowingFail(id: string, error: unknown) {
  return {
    type: FOLLOWING_EXPAND_FAIL,
    id,
    error,
  };
}

const debouncedFetchRelationships = debounceWithDispatchAndArguments<string>((dispatch, ...newAccountIds) => {
  if (newAccountIds.length === 0) {
    return;
  }

  dispatch(fetchRelationshipsRequest(newAccountIds));

  apiGetRelationships(newAccountIds).then(relationships => {
    dispatch(fetchRelationshipsSuccess({ relationships }));
  }).catch((error: unknown) => {
    dispatch(fetchRelationshipsFail(error));
  });
}, { delay: 500 });

export function fetchRelationships(accountIds: string[]) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const state = getState();
    const loadedRelationships = state.relationships;
    const newAccountIds = accountIds.filter(id => loadedRelationships.get(id, null) === null);
    const signedIn = !!state.meta.get('me');

    if (!signedIn || newAccountIds.length === 0) {
      return;
    }

    debouncedFetchRelationships(dispatch, ...newAccountIds);
  };
}

export function fetchRelationshipsRequest(ids: string[]) {
  return {
    type: RELATIONSHIPS_FETCH_REQUEST,
    ids,
    skipLoading: true,
  };
}

export function fetchRelationshipsFail(error: unknown) {
  return {
    type: RELATIONSHIPS_FETCH_FAIL,
    error,
    skipLoading: true,
    skipNotFound: true,
  };
}

export function fetchFollowRequests() {
  return (dispatch: AppDispatch) => {
    dispatch(fetchFollowRequestsRequest());

    apiGetFollowRequests().then(({ accounts, links }) => {
      dispatch(importFetchedAccounts(accounts));
      dispatch(fetchFollowRequestsSuccess(accounts, getNextLinkUri(links)));
    }).catch((error: unknown) => dispatch(fetchFollowRequestsFail(error)));
  };
}

export function fetchFollowRequestsRequest() {
  return {
    type: FOLLOW_REQUESTS_FETCH_REQUEST,
  };
}

export function fetchFollowRequestsSuccess(accounts: ApiAccountJSON[], next: string | null) {
  return {
    type: FOLLOW_REQUESTS_FETCH_SUCCESS,
    accounts,
    next,
  };
}

export function fetchFollowRequestsFail(error: unknown) {
  return {
    type: FOLLOW_REQUESTS_FETCH_FAIL,
    error,
  };
}

export function expandFollowRequests() {
  return (dispatch: AppDispatch, getState: GetState) => {
    const url = getState().user_lists.getIn(['follow_requests', 'next']);

    if (typeof url !== 'string') {
      return;
    }

    dispatch(expandFollowRequestsRequest());

    apiGetFollowRequests(url).then(({ accounts, links }) => {
      dispatch(importFetchedAccounts(accounts));
      dispatch(expandFollowRequestsSuccess(accounts, getNextLinkUri(links)));
    }).catch((error: unknown) => dispatch(expandFollowRequestsFail(error)));
  };
}

export function expandFollowRequestsRequest() {
  return {
    type: FOLLOW_REQUESTS_EXPAND_REQUEST,
  };
}

export function expandFollowRequestsSuccess(accounts: ApiAccountJSON[], next: string | null) {
  return {
    type: FOLLOW_REQUESTS_EXPAND_SUCCESS,
    accounts,
    next,
  };
}

export function expandFollowRequestsFail(error: unknown) {
  return {
    type: FOLLOW_REQUESTS_EXPAND_FAIL,
    error,
  };
}

export function authorizeFollowRequest(id: string) {
  return (dispatch: AppDispatch) => {
    dispatch(authorizeFollowRequestRequest(id));

    apiAuthorizeFollowRequest(id)
      .then(() => dispatch(authorizeFollowRequestSuccess({ id })))
      .catch((error: unknown) => dispatch(authorizeFollowRequestFail(id, error)));
  };
}

export function authorizeFollowRequestRequest(id: string) {
  return {
    type: FOLLOW_REQUEST_AUTHORIZE_REQUEST,
    id,
  };
}

export function authorizeFollowRequestFail(id: string, error: unknown) {
  return {
    type: FOLLOW_REQUEST_AUTHORIZE_FAIL,
    id,
    error,
  };
}


export function rejectFollowRequest(id: string) {
  return (dispatch: AppDispatch) => {
    dispatch(rejectFollowRequestRequest(id));

    apiRejectFollowRequest(id)
      .then(() => dispatch(rejectFollowRequestSuccess({ id })))
      .catch((error: unknown) => dispatch(rejectFollowRequestFail(id, error)));
  };
}

export function rejectFollowRequestRequest(id: string) {
  return {
    type: FOLLOW_REQUEST_REJECT_REQUEST,
    id,
  };
}

export function rejectFollowRequestFail(id: string, error: unknown) {
  return {
    type: FOLLOW_REQUEST_REJECT_FAIL,
    id,
    error,
  };
}

// Upstream's `pin` / `unpin` requests are Mastodon 4.4's `endorse` / `unendorse`.
export function pinAccount(id: string) {
  return (dispatch: AppDispatch) => {
    dispatch(pinAccountRequest(id));

    apiEndorseAccount(id).then(relationship => {
      dispatch(pinAccountSuccess({ relationship }));
      if (me) void dispatch(fetchEndorsedAccounts({ accountId: me }));
    }).catch((error: unknown) => {
      dispatch(pinAccountFail(error));
    });
  };
}

export function unpinAccount(id: string) {
  return (dispatch: AppDispatch) => {
    dispatch(unpinAccountRequest(id));

    apiUnendorseAccount(id).then(relationship => {
      dispatch(unpinAccountSuccess({ relationship }));
      if (me) void dispatch(fetchEndorsedAccounts({ accountId: me }));
    }).catch((error: unknown) => {
      dispatch(unpinAccountFail(error));
    });
  };
}

export function pinAccountRequest(id: string) {
  return {
    type: ACCOUNT_PIN_REQUEST,
    id,
  };
}

export function pinAccountFail(error: unknown) {
  return {
    type: ACCOUNT_PIN_FAIL,
    error,
  };
}

export function unpinAccountRequest(id: string) {
  return {
    type: ACCOUNT_UNPIN_REQUEST,
    id,
  };
}

export function unpinAccountFail(error: unknown) {
  return {
    type: ACCOUNT_UNPIN_FAIL,
    error,
  };
}

export const updateAccount = ({ displayName, note, avatar, header, discoverable, indexable }: {
  displayName: string;
  note: string;
  avatar?: File;
  header?: File;
  discoverable: boolean;
  indexable: boolean;
}) => (dispatch: AppDispatch) =>
  apiUpdateCredentials({
    display_name: displayName,
    note,
    avatar,
    header,
    discoverable,
    indexable,
  }).then(account => {
    dispatch(importFetchedAccount(account));
  });

export const navigateToProfile = (accountId: string) => {
  return (_dispatch: AppDispatch, getState: GetState) => {
    const acct = getState().accounts.get(accountId)?.acct;

    if (acct) {
      browserHistory.push(`/@${acct}`);
    }
  };
};
