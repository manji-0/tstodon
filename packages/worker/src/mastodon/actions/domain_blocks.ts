import { apiBlockDomain, apiUnblockDomain } from 'mastodon/api/domain_blocks';
import type { Account } from 'mastodon/models/account';
import type { AppDispatch, GetState, RootState } from 'mastodon/store';

import { blockDomainSuccess, unblockDomainSuccess } from './domain_blocks_typed';
import { openModal } from './modal';


export * from './domain_blocks_typed';

export const DOMAIN_BLOCK_REQUEST = 'DOMAIN_BLOCK_REQUEST';
export const DOMAIN_BLOCK_FAIL    = 'DOMAIN_BLOCK_FAIL';

export const DOMAIN_UNBLOCK_REQUEST = 'DOMAIN_UNBLOCK_REQUEST';
export const DOMAIN_UNBLOCK_FAIL    = 'DOMAIN_UNBLOCK_FAIL';

/** The ids of the known accounts on `domain`. */
const accountIdsOnDomain = (state: RootState, domain: string) => {
  const at_domain = '@' + domain;
  return state.accounts.filter(item => item.acct.endsWith(at_domain)).valueSeq().map(item => item.id).toArray();
};

export function blockDomain(domain: string) {
  return (dispatch: AppDispatch, getState: GetState) => {
    dispatch(blockDomainRequest(domain));

    apiBlockDomain(domain).then(() => {
      const accounts = accountIdsOnDomain(getState(), domain);

      dispatch(blockDomainSuccess({ domain, accounts }));
    }).catch((err: unknown) => {
      dispatch(blockDomainFail(domain, err));
    });
  };
}

export function blockDomainRequest(domain: string) {
  return {
    type: DOMAIN_BLOCK_REQUEST,
    domain,
  };
}

export function blockDomainFail(domain: string, error: unknown) {
  return {
    type: DOMAIN_BLOCK_FAIL,
    domain,
    error,
  };
}

export function unblockDomain(domain: string) {
  return (dispatch: AppDispatch, getState: GetState) => {
    dispatch(unblockDomainRequest(domain));

    apiUnblockDomain(domain).then(() => {
      const accounts = accountIdsOnDomain(getState(), domain);
      dispatch(unblockDomainSuccess({ domain, accounts }));
    }).catch((err: unknown) => {
      dispatch(unblockDomainFail(domain, err));
    });
  };
}

export function unblockDomainRequest(domain: string) {
  return {
    type: DOMAIN_UNBLOCK_REQUEST,
    domain,
  };
}

export function unblockDomainFail(domain: string, error: unknown) {
  return {
    type: DOMAIN_UNBLOCK_FAIL,
    domain,
    error,
  };
}

export const initDomainBlockModal = (account: Account) => (dispatch: AppDispatch) => dispatch(openModal({
  modalType: 'DOMAIN_BLOCK',
  modalProps: {
    domain: account.get('acct').split('@')[1],
    acct: account.get('acct'),
    accountId: account.get('id'),
  },
}));
