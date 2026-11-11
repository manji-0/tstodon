import { createReducer } from '@reduxjs/toolkit';

import type { ApiInitialStateMetaJSON } from '@tstodon/api';
import { changeLayout, needsReload } from 'mastodon/actions/app';
import { STORE_HYDRATE } from 'mastodon/actions/store';
import type { StoreHydrateAction } from 'mastodon/actions/store';
import { layoutFromWindow } from 'mastodon/is_mobile';
import type { LayoutType } from 'mastodon/is_mobile';
import { immutableMapOf } from 'mastodon/utils/immutable_map_of';
import type { ImmutableMapOf, ImmutableOf } from 'mastodon/utils/immutable_map_of';

/**
 * The initial state's `meta` (without `access_token`), as Immutable values.
 * Each key is there once the store is hydrated with it; before that (and on
 * the pages that hydrate part of it) it is missing. `access_token` is
 * removed as soon as it is merged in.
 */
type HydratedMeta = {
  [K in Exclude<
    keyof ApiInitialStateMetaJSON,
    'streaming_api_base_url'
  >]?: ImmutableOf<ApiInitialStateMetaJSON[K]>;
};

export type MetaShape = HydratedMeta & {
  streaming_api_base_url: string | null;
  layout: LayoutType;
  /** The viewer's role permissions; `undefined` once hydrated signed out. */
  permissions: string | undefined;
  needsReload: boolean;
};

export type MetaState = ImmutableMapOf<MetaShape>;

const initialState: MetaState = immutableMapOf<MetaShape>({
  streaming_api_base_url: null,
  layout: layoutFromWindow(),
  permissions: '0',
  needsReload: false,
});

export default createReducer(initialState, (builder) => {
  builder
    .addCase(STORE_HYDRATE, (state, action: StoreHydrateAction) => {
      const meta = action.state.get('meta');

      // we do not want `access_token` to be stored in the state
      return (meta ? state.merge(meta) : state)
        .delete('access_token')
        .set('permissions', action.state.get('role')?.get('permissions'));
    })
    .addCase(changeLayout, (state, action) =>
      state.set('layout', action.payload.layout),
    )
    .addCase(needsReload, (state) => state.set('needsReload', true));
});
