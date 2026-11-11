import type { Filter } from 'mastodon/reducers/filters';
import { createAppSelector } from 'mastodon/store';
import { toServerSideType } from 'mastodon/utils/filters';

import type { StatusContextType } from '../components/status/types';

import { selectExpandedStatus } from './statuses';

/** A filter of the store as a plain object (`expires_at` in milliseconds). */
export interface FilterShape {
  id: string;
  title: string;
  context: string[];
  expires_at: number | null;
  filter_action: 'hide' | 'blur' | 'warn';
}

export const getFilters = createAppSelector(
  [
    (state) => state.filters,
    (_, { contextType }: { contextType?: string }) => contextType,
  ],
  (filters, contextType) => {
    if (!contextType) {
      return null;
    }

    const now = Date.now();
    const serverSideType = toServerSideType(contextType);

    return filters.filter((filter) => {
      const expiration = filter.get('expires_at');
      return (
        filter.get('context').includes(serverSideType) &&
        (expiration === null || expiration > now)
      );
    });
  },
);

const toPlainFilter = (filter: Filter): FilterShape => ({
  id: filter.get('id'),
  title: filter.get('title'),
  context: filter.get('context').toArray(),
  expires_at: filter.get('expires_at'),
  filter_action: filter.get('filter_action'),
});

export const selectPlainFilters = createAppSelector([getFilters], (filters) => {
  if (!filters) {
    return null;
  }
  return filters.map(toPlainFilter).toObject();
});

export const selectStatusFilters = createAppSelector(
  [
    (state, { statusId }: { statusId?: string | null }) =>
      selectExpandedStatus(state, statusId ?? undefined),
    selectPlainFilters,
    (_, { warnInsteadOfHide }: { warnInsteadOfHide?: boolean }) =>
      warnInsteadOfHide,
  ],
  (status, filters) => {
    const results: FilterShape[] = [];
    if (!status || !filters) {
      return results;
    }
    const filtered = status.reblog?.filtered ?? status.filtered;
    for (const result of filtered) {
      const filter = filters[result.filter];
      if (!filter) {
        continue;
      }

      results.push(filter);
    }

    return results;
  },
);

export const selectStatusLoadingState = createAppSelector(
  [
    (state, { statusId }: { statusId?: string | null }) =>
      selectExpandedStatus(state, statusId ?? undefined),
    selectStatusFilters,
    (_, { warnInsteadOfHide }: { warnInsteadOfHide?: boolean }) =>
      warnInsteadOfHide,
  ],
  (status, filters, warnInsteadOfHide) => {
    if (!status) {
      return { state: 'not-found', status: null };
    }

    if (status.isLoading) {
      return { state: 'loading', status: null };
    }

    if (
      !warnInsteadOfHide &&
      filters.some((filter) => filter.filter_action === 'hide')
    ) {
      return { state: 'filtered', status: null };
    }

    return { state: 'loaded', status };
  },
);

export const selectMediaFilters = createAppSelector(
  [selectStatusFilters],
  (filters) =>
    filters
      .filter((filter) => filter.filter_action === 'blur')
      .map((filter) => filter.title),
);

export const getStatusHidden = createAppSelector(
  [
    (state, { contextType }: { contextType: StatusContextType }) =>
      getFilters(state, { contextType }),
    (state, { id }: { id: string }) =>
      state.statuses.get(id)?.get('filtered'),
  ],
  (filters, filtered) => {
    if (!filters) {
      return false;
    }

    return filtered?.some(
      (result) =>
        filters.getIn([result.get('filter'), 'filter_action']) === 'hide',
    );
  },
);
