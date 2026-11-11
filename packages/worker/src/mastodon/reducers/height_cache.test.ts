import { Map as ImmutableMap } from 'immutable';

import { clearHeight, setHeight } from '../actions/height_cache';

import heightCache from './height_cache';

describe('height_cache reducer', () => {
  it('starts empty', () => {
    expect(heightCache(undefined, { type: 'INIT' })).toEqual(ImmutableMap());
  });

  it('sets a height by key and id', () => {
    let state = heightCache(undefined, setHeight('home', '1', 100));
    state = heightCache(state, setHeight('home', '2', 200));
    state = heightCache(state, setHeight('public', '1', 50));

    expect(state.toJS()).toEqual({
      home: { '1': 100, '2': 200 },
      public: { '1': 50 },
    });
  });

  it('clears every height', () => {
    const state = heightCache(undefined, setHeight('home', '1', 100));

    expect(heightCache(state, clearHeight())).toEqual(ImmutableMap());
  });

  it('keeps the state on other actions', () => {
    const state = heightCache(undefined, setHeight('home', '1', 100));

    expect(heightCache(state, { type: 'OTHER' })).toBe(state);
  });
});
