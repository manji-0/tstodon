import { createReducer } from '@reduxjs/toolkit';
import { Map as ImmutableMap, is } from 'immutable';
import type { List as ImmutableList } from 'immutable';

import type { ApiFilterJSON, ApiFilterKeywordJSON } from '@tstodon/api';

import { FILTERS_CREATE_SUCCESS, FILTERS_FETCH_SUCCESS } from '../actions/filters';
import type {
  createFilterSuccess,
  FiltersFetchSuccessAction,
} from '../actions/filters';
import { FILTERS_IMPORT } from '../actions/importer';
import type { importFilters } from '../actions/importer';
import { immutableFromJS } from '../utils/immutable_map_of';
import type { ImmutableMapOf } from '../utils/immutable_map_of';
import type { PlainActionOf } from '../utils/types';

/** A filter (`ApiFilterJSON`) as the store keeps it. */
export interface FilterShape {
  id: string;
  title: string;
  context: ImmutableList<ApiFilterJSON['context'][number]>;
  filter_action: ApiFilterJSON['filter_action'];
  /**
   * `undefined` until a filter with its keywords comes in: the filters a
   * status's `filtered` results carry have none, and do not overwrite them.
   */
  keywords: ImmutableList<ImmutableMapOf<ApiFilterKeywordJSON>> | undefined;
  /** In milliseconds since the epoch (`Date.parse`), or `null` if it never expires. */
  expires_at: number | null;
}

export type Filter = ImmutableMapOf<FilterShape>;

/** The filters, by id. */
type State = ImmutableMap<string, Filter>;

const normalizeFilter = (state: State, filter: ApiFilterJSON): State => {
  const normalizedFilter: Filter = immutableFromJS({
    id: filter.id,
    title: filter.title,
    context: filter.context,
    filter_action: filter.filter_action,
    keywords: filter.keywords,
    expires_at: filter.expires_at ? Date.parse(filter.expires_at) : null,
  });

  const old = state.get(filter.id);

  if (is(old, normalizedFilter)) {
    return state;
  } else if (old) {
    // Do not overwrite keywords when receiving a partial filter
    return state.set(
      filter.id,
      old.mergeWith(
        (old_value, new_value) =>
          new_value === undefined ? old_value : new_value,
        normalizedFilter,
      ),
    );
  } else {
    // (Upstream merged it into an empty Map, which gives the same Map.)
    return state.set(filter.id, normalizedFilter);
  }
};

const normalizeFilters = (state: State, filters: ApiFilterJSON[]) => {
  filters.forEach((filter) => {
    state = normalizeFilter(state, filter);
  });

  return state;
};

const initialState: State = ImmutableMap();

export default createReducer(initialState, (builder) => {
  builder
    .addCase(
      FILTERS_CREATE_SUCCESS,
      (state, action: ReturnType<typeof createFilterSuccess>) =>
        normalizeFilter(state, action.filter),
    )
    .addCase(FILTERS_FETCH_SUCCESS, (_state, action: FiltersFetchSuccessAction) =>
      normalizeFilters(ImmutableMap(), action.filters),
    )
    .addCase(
      FILTERS_IMPORT,
      (
        state,
        action: PlainActionOf<typeof FILTERS_IMPORT, typeof importFilters>,
      ) => normalizeFilters(state, action.filters),
    );
});
