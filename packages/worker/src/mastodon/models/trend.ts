import type { Map as ImmutableMap } from 'immutable';
import { List as ImmutableList } from 'immutable';

/**
 * A trending hashtag (`ApiHashtagJSON`) or link (`ApiTrendsLinkJSON`)
 * through `fromJS`. Its fields stay `unknown`, as Immutable 4 types a `Map`
 * with one value type, and are narrowed where they are read.
 */
export type TrendItem = ImmutableMap<string, unknown>;

export interface TrendListFields {
  items: ImmutableList<TrendItem>;
  isLoading: boolean;
}

export type TrendList = ImmutableMap<
  keyof TrendListFields,
  TrendListFields[keyof TrendListFields]
>;

/** The trending hashtags (`tags`) and links (`links`), `reducers/trends.ts`. */
export type TrendsState = ImmutableMap<'tags' | 'links', TrendList>;

const emptyItems = ImmutableList<TrendItem>();

/** The trending hashtags or links. */
export const getTrendItems = (
  state: TrendsState,
  key: 'tags' | 'links',
): ImmutableList<TrendItem> => {
  const items = state.get(key)?.get('items');
  return ImmutableList.isList(items) ? items : emptyItems;
};
