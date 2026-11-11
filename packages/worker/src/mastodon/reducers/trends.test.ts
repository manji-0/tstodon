import { fromJS } from 'immutable';

import type { ApiHashtagJSON } from '@tstodon/api';

import {
  fetchTrendingHashtagsFail,
  fetchTrendingHashtagsRequest,
  fetchTrendingHashtagsSuccess,
  fetchTrendingLinksRequest,
} from '../actions/trends';
import { getTrendItems } from '../models/trend';

import trends from './trends';

const hashtag = (name: string): ApiHashtagJSON => ({
  id: name,
  name,
  url: `https://example.com/tags/${name}`,
  history: [{ day: '1700000000', uses: '3', accounts: '2' }],
});

describe('trends reducer', () => {
  test('starts with no trends', () => {
    expect(trends(undefined, { type: 'INIT' }).toJS()).toEqual({
      tags: { items: [], isLoading: false },
      links: { items: [], isLoading: false },
    });
  });

  test('stores the trending hashtags as Immutable maps', () => {
    let state = trends(undefined, fetchTrendingHashtagsRequest());
    expect(state.getIn(['tags', 'isLoading'])).toBe(true);

    const tags = [hashtag('cats'), hashtag('dogs')];
    state = trends(state, fetchTrendingHashtagsSuccess(tags));
    expect(getTrendItems(state, 'tags')).toEqual(fromJS(tags));
    expect(state.getIn(['tags', 'isLoading'])).toBe(false);
    expect(getTrendItems(state, 'links').isEmpty()).toBe(true);
  });

  test('stops loading on a failure', () => {
    let state = trends(undefined, fetchTrendingLinksRequest());
    state = trends(state, fetchTrendingHashtagsRequest());
    state = trends(state, fetchTrendingHashtagsFail(new Error()));
    expect(state.getIn(['tags', 'isLoading'])).toBe(false);
    expect(state.getIn(['links', 'isLoading'])).toBe(true);
  });
});
