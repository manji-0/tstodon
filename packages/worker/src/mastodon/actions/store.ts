import type { ApiAccountJSON, ApiInitialStateJSON } from '@tstodon/api';
import type { AppDispatch } from 'mastodon/store';
import { immutableFromJS } from 'mastodon/utils/immutable_map_of';
import type { ImmutableOf } from 'mastodon/utils/immutable_map_of';

import { hydrateCompose } from './compose';
import { importFetchedAccounts } from './importer';
import { hydrateSearch } from './search';

export const STORE_HYDRATE = 'STORE_HYDRATE' as const;
export const STORE_HYDRATE_LAZY = 'STORE_HYDRATE_LAZY';

/**
 * The initial state, or the part of it a standalone page (the annual
 * report's shared page) builds itself, whose `accounts` may be a list.
 */
export type HydrateState = Partial<Omit<ApiInitialStateJSON, 'meta' | 'accounts'>> & {
  meta?: Partial<ApiInitialStateJSON['meta']>;
  accounts?: Record<string, ApiAccountJSON> | ApiAccountJSON[];
};

/** `STORE_HYDRATE`: the hydrated state as Immutable values (as `fromJS` makes them). */
export type StoreHydrateAction = {
  type: typeof STORE_HYDRATE;
  state: ImmutableOf<HydrateState>;
};

// Upstream passed a reviver making a `List` of every array and a `Map` of
// every object, which is what `fromJS` does by default for JSON values.
const convertState = (rawState: HydrateState) => immutableFromJS(rawState);

export function hydrateStore(rawState: HydrateState) {
  return (dispatch: AppDispatch) => {
    const state = convertState(rawState);

    dispatch({
      type: STORE_HYDRATE,
      state,
    } satisfies StoreHydrateAction);

    dispatch(hydrateCompose());
    dispatch(hydrateSearch());
    if (rawState.accounts) {
      dispatch(importFetchedAccounts(Object.values(rawState.accounts)));
    }
  };
}
