import type { List as ImmutableList, Map as ImmutableMap } from 'immutable';

import type { ImmutableMapOf } from '../utils/immutable_map_of';

/**
 * A trending hashtag (`ApiHashtagJSON`) or link (`ApiTrendsLinkJSON`)
 * through `fromJS`. Its fields stay `unknown` and are narrowed where they
 * are read.
 */
export type TrendItem = ImmutableMap<string, unknown>;

export interface TrendListFields {
  items: ImmutableList<TrendItem>;
  isLoading: boolean;
}

export type TrendList = ImmutableMapOf<TrendListFields>;

/** The trending hashtags (`tags`) and links (`links`), `reducers/trends.ts`. */
export type TrendsState = ImmutableMapOf<{ tags: TrendList; links: TrendList }>;
