import { createReducer } from '@reduxjs/toolkit';
import { List as ImmutableList, fromJS } from 'immutable';

import {
  TRENDS_TAGS_FETCH_REQUEST,
  TRENDS_TAGS_FETCH_SUCCESS,
  TRENDS_TAGS_FETCH_FAIL,
  TRENDS_LINKS_FETCH_REQUEST,
  TRENDS_LINKS_FETCH_SUCCESS,
  TRENDS_LINKS_FETCH_FAIL,
} from 'mastodon/actions/trends';
import type {
  fetchTrendingHashtagsRequest,
  fetchTrendingHashtagsSuccess,
  fetchTrendingHashtagsFail,
  fetchTrendingLinksRequest,
  fetchTrendingLinksSuccess,
  fetchTrendingLinksFail,
} from 'mastodon/actions/trends';

import type {
  TrendItem,
  TrendList,
  TrendListFields,
  TrendsState,
} from '../models/trend';
import { immutableMapOf } from '../utils/immutable_map_of';

import { matchAction } from './match_action';

const newList = (): TrendList =>
  immutableMapOf<TrendListFields>({
    items: ImmutableList<TrendItem>(),
    isLoading: false,
  });

const initialState: TrendsState = immutableMapOf<{
  tags: TrendList;
  links: TrendList;
}>({
  tags: newList(),
  links: newList(),
});

const setItems = (
  state: TrendsState,
  key: 'tags' | 'links',
  items: ImmutableList<TrendItem>,
) =>
  state.withMutations((map) => {
    map.setIn([key, 'items'], items);
    map.setIn([key, 'isLoading'], false);
  });

const isTagsRequest = matchAction<
  ReturnType<typeof fetchTrendingHashtagsRequest>
>(TRENDS_TAGS_FETCH_REQUEST);
const isTagsSuccess = matchAction<
  ReturnType<typeof fetchTrendingHashtagsSuccess>
>(TRENDS_TAGS_FETCH_SUCCESS);
const isTagsFail = matchAction<ReturnType<typeof fetchTrendingHashtagsFail>>(
  TRENDS_TAGS_FETCH_FAIL,
);
const isLinksRequest = matchAction<
  ReturnType<typeof fetchTrendingLinksRequest>
>(TRENDS_LINKS_FETCH_REQUEST);
const isLinksSuccess = matchAction<
  ReturnType<typeof fetchTrendingLinksSuccess>
>(TRENDS_LINKS_FETCH_SUCCESS);
const isLinksFail = matchAction<ReturnType<typeof fetchTrendingLinksFail>>(
  TRENDS_LINKS_FETCH_FAIL,
);

const trendsReducer = createReducer(initialState, (builder) => {
  builder
    .addMatcher(isTagsRequest, (state) =>
      state.setIn(['tags', 'isLoading'], true),
    )
    .addMatcher(isTagsSuccess, (state, action) =>
      setItems(state, 'tags', fromJS(action.trends)),
    )
    .addMatcher(isTagsFail, (state) =>
      state.setIn(['tags', 'isLoading'], false),
    )
    .addMatcher(isLinksRequest, (state) =>
      state.setIn(['links', 'isLoading'], true),
    )
    .addMatcher(isLinksSuccess, (state, action) =>
      setItems(state, 'links', fromJS(action.trends)),
    )
    .addMatcher(isLinksFail, (state) =>
      state.setIn(['links', 'isLoading'], false),
    );
});

export default trendsReducer;
