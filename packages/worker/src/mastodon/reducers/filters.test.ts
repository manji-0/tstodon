import type { ApiFilterJSON } from '@tstodon/api';

import {
  createFilterSuccess,
  FILTERS_FETCH_SUCCESS,
} from '../actions/filters';
import type { FiltersFetchSuccessAction } from '../actions/filters';
import { importFilters } from '../actions/importer';

import filters from './filters';

const filter: ApiFilterJSON = {
  id: '1',
  title: 'Spoilers',
  context: ['home', 'public'],
  expires_at: '2030-01-01T00:00:00.000Z',
  filter_action: 'warn',
  keywords: [{ id: '10', keyword: 'finale', whole_word: true }],
  statuses: [],
};

const fetched = (list: ApiFilterJSON[]): FiltersFetchSuccessAction => ({
  type: FILTERS_FETCH_SUCCESS,
  filters: list,
  skipLoading: true,
});

describe('filters reducer', () => {
  it('stores a created filter by id', () => {
    const state = filters(undefined, createFilterSuccess(filter));

    expect(state.get('1')?.toJS()).toEqual({
      id: '1',
      title: 'Spoilers',
      context: ['home', 'public'],
      filter_action: 'warn',
      keywords: [{ id: '10', keyword: 'finale', whole_word: true }],
      expires_at: Date.parse('2030-01-01T00:00:00.000Z'),
    });
  });

  it('keeps the keywords when a filter comes without them', () => {
    let state = filters(undefined, createFilterSuccess(filter));
    const { keywords: _keywords, ...partial } = filter;
    state = filters(
      state,
      importFilters([{ ...partial, title: 'Renamed', expires_at: null }]),
    );

    expect(state.get('1')?.get('title')).toBe('Renamed');
    expect(state.get('1')?.get('expires_at')).toBeNull();
    expect(state.get('1')?.get('keywords')?.size).toBe(1);
  });

  it('keeps the same state for an unchanged filter', () => {
    const state = filters(undefined, createFilterSuccess(filter));

    expect(filters(state, importFilters([filter]))).toBe(state);
  });

  it('replaces every filter when they are fetched', () => {
    let state = filters(undefined, createFilterSuccess(filter));
    state = filters(state, fetched([{ ...filter, id: '2' }]));

    expect(state.keySeq().toArray()).toEqual(['2']);
  });
});
