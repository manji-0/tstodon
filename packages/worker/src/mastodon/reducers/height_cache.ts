import { createReducer } from '@reduxjs/toolkit';
import { Map as ImmutableMap } from 'immutable';

import { HEIGHT_CACHE_CLEAR, HEIGHT_CACHE_SET } from '../actions/height_cache';
import type { setHeight as setHeightAction } from '../actions/height_cache';

/** The rendered heights of list items: by `saveHeightKey`, then by item id. */
type State = ImmutableMap<string, ImmutableMap<string, number>>;

const initialState: State = ImmutableMap();

const setHeight = (state: State, key: string, id: string, height: number) => {
  return state.update(key, ImmutableMap<string, number>(), map => map.set(id, height));
};

const clearHeights = (): State => {
  return ImmutableMap();
};

export default createReducer(initialState, (builder) => {
  builder
    .addCase(HEIGHT_CACHE_SET, (state, action: ReturnType<typeof setHeightAction>) =>
      setHeight(state, action.key, action.id, action.height))
    .addCase(HEIGHT_CACHE_CLEAR, () => clearHeights());
});
