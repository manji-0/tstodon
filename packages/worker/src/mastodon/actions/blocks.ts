import { getNextLinkUri } from 'mastodon/api';
import { apiGetBlocks } from 'mastodon/api/accounts';
import type { ApiAccountJSON } from 'mastodon/api_types/accounts';
import type { Account } from 'mastodon/models/account';
import type { AppDispatch, GetState } from 'mastodon/store';

import { fetchRelationships } from './accounts';
import { importFetchedAccounts } from './importer';
import { openModal } from './modal';

export const BLOCKS_FETCH_REQUEST = 'BLOCKS_FETCH_REQUEST';
export const BLOCKS_FETCH_SUCCESS = 'BLOCKS_FETCH_SUCCESS';
export const BLOCKS_FETCH_FAIL    = 'BLOCKS_FETCH_FAIL';

export const BLOCKS_EXPAND_REQUEST = 'BLOCKS_EXPAND_REQUEST';
export const BLOCKS_EXPAND_SUCCESS = 'BLOCKS_EXPAND_SUCCESS';
export const BLOCKS_EXPAND_FAIL    = 'BLOCKS_EXPAND_FAIL';

export function fetchBlocks() {
  return (dispatch: AppDispatch) => {
    dispatch(fetchBlocksRequest());

    apiGetBlocks().then(({ accounts, links }) => {
      dispatch(importFetchedAccounts(accounts));
      dispatch(fetchBlocksSuccess(accounts, getNextLinkUri(links)));
      dispatch(fetchRelationships(accounts.map(item => item.id)));
    }).catch((error: unknown) => dispatch(fetchBlocksFail(error)));
  };
}

export function fetchBlocksRequest() {
  return {
    type: BLOCKS_FETCH_REQUEST,
  };
}

export function fetchBlocksSuccess(accounts: ApiAccountJSON[], next: string | null) {
  return {
    type: BLOCKS_FETCH_SUCCESS,
    accounts,
    next,
  };
}

export function fetchBlocksFail(error: unknown) {
  return {
    type: BLOCKS_FETCH_FAIL,
    error,
  };
}

export function expandBlocks() {
  return (dispatch: AppDispatch, getState: GetState) => {
    const url = getState().user_lists.getIn(['blocks', 'next']);

    if (typeof url !== 'string') {
      return;
    }

    dispatch(expandBlocksRequest());

    apiGetBlocks(url).then(({ accounts, links }) => {
      dispatch(importFetchedAccounts(accounts));
      dispatch(expandBlocksSuccess(accounts, getNextLinkUri(links)));
      dispatch(fetchRelationships(accounts.map(item => item.id)));
    }).catch((error: unknown) => dispatch(expandBlocksFail(error)));
  };
}

export function expandBlocksRequest() {
  return {
    type: BLOCKS_EXPAND_REQUEST,
  };
}

export function expandBlocksSuccess(accounts: ApiAccountJSON[], next: string | null) {
  return {
    type: BLOCKS_EXPAND_SUCCESS,
    accounts,
    next,
  };
}

export function expandBlocksFail(error: unknown) {
  return {
    type: BLOCKS_EXPAND_FAIL,
    error,
  };
}

export function initBlockModal(account: Account) {
  return (dispatch: AppDispatch) => {
    dispatch(openModal({
      modalType: 'BLOCK',
      modalProps: {
        accountId: account.get('id'),
        acct: account.get('acct'),
      },
    }));
  };
}
