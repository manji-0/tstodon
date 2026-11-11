import { getNextLinkUri } from 'mastodon/api';
import { apiGetMutes } from 'mastodon/api/accounts';
import type { ApiAccountJSON } from 'mastodon/api_types/accounts';
import type { Account } from 'mastodon/models/account';
import type { AppDispatch, GetState } from 'mastodon/store';

import { fetchRelationships } from './accounts';
import { importFetchedAccounts } from './importer';
import { openModal } from './modal';

export const MUTES_FETCH_REQUEST = 'MUTES_FETCH_REQUEST' as const;
export const MUTES_FETCH_SUCCESS = 'MUTES_FETCH_SUCCESS' as const;
export const MUTES_FETCH_FAIL    = 'MUTES_FETCH_FAIL' as const;

export const MUTES_EXPAND_REQUEST = 'MUTES_EXPAND_REQUEST' as const;
export const MUTES_EXPAND_SUCCESS = 'MUTES_EXPAND_SUCCESS' as const;
export const MUTES_EXPAND_FAIL    = 'MUTES_EXPAND_FAIL' as const;

export function fetchMutes() {
  return (dispatch: AppDispatch) => {
    dispatch(fetchMutesRequest());

    apiGetMutes().then(({ accounts, links }) => {
      dispatch(importFetchedAccounts(accounts));
      dispatch(fetchMutesSuccess(accounts, getNextLinkUri(links)));
      dispatch(fetchRelationships(accounts.map(item => item.id)));
    }).catch((error: unknown) => dispatch(fetchMutesFail(error)));
  };
}

export function fetchMutesRequest() {
  return {
    type: MUTES_FETCH_REQUEST,
  };
}

export function fetchMutesSuccess(accounts: ApiAccountJSON[], next: string | null) {
  return {
    type: MUTES_FETCH_SUCCESS,
    accounts,
    next,
  };
}

export function fetchMutesFail(error: unknown) {
  return {
    type: MUTES_FETCH_FAIL,
    error,
  };
}

export function expandMutes() {
  return (dispatch: AppDispatch, getState: GetState) => {
    const url = getState().user_lists.getIn(['mutes', 'next']);

    if (typeof url !== 'string') {
      return;
    }

    dispatch(expandMutesRequest());

    apiGetMutes(url).then(({ accounts, links }) => {
      dispatch(importFetchedAccounts(accounts));
      dispatch(expandMutesSuccess(accounts, getNextLinkUri(links)));
      dispatch(fetchRelationships(accounts.map(item => item.id)));
    }).catch((error: unknown) => dispatch(expandMutesFail(error)));
  };
}

export function expandMutesRequest() {
  return {
    type: MUTES_EXPAND_REQUEST,
  };
}

export function expandMutesSuccess(accounts: ApiAccountJSON[], next: string | null) {
  return {
    type: MUTES_EXPAND_SUCCESS,
    accounts,
    next,
  };
}

export function expandMutesFail(error: unknown) {
  return {
    type: MUTES_EXPAND_FAIL,
    error,
  };
}

export function initMuteModal(account: Account) {
  return (dispatch: AppDispatch) => {
    dispatch(openModal({
      modalType: 'MUTE',
      modalProps: {
        accountId: account.get('id'),
        acct: account.get('acct'),
      },
    }));
  };
}
