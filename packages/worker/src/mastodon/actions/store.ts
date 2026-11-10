import { fromJS, isIndexed } from 'immutable';

import type { ApiAccountJSON, ApiInitialStateJSON } from '@tstodon/api';
import type { AppDispatch } from 'mastodon/store';

import { hydrateCompose } from './compose';
import { importFetchedAccounts } from './importer';
import { hydrateSearch } from './search';

export const STORE_HYDRATE = 'STORE_HYDRATE';
export const STORE_HYDRATE_LAZY = 'STORE_HYDRATE_LAZY';

/**
 * The initial state, or the part of it a standalone page (the annual
 * report's shared page) builds itself, whose `accounts` may be a list.
 */
export type HydrateState = Partial<Omit<ApiInitialStateJSON, 'meta' | 'accounts'>> & {
  meta?: Partial<ApiInitialStateJSON['meta']>;
  accounts?: Record<string, ApiAccountJSON> | ApiAccountJSON[];
};

const convertState = (rawState: HydrateState) =>
  fromJS(rawState, (k, v) =>
    isIndexed(v) ? v.toList() : v.toMap());

export function hydrateStore(rawState: HydrateState) {
  return (dispatch: AppDispatch) => {
    const state = convertState(rawState);

    dispatch({
      type: STORE_HYDRATE,
      state,
    });

    dispatch(hydrateCompose());
    dispatch(hydrateSearch());
    if (rawState.accounts) {
      dispatch(importFetchedAccounts(Object.values(rawState.accounts)));
    }
  };
}
