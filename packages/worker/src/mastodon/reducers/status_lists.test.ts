import LinkHeader from 'http-link-header';

import { relationshipsFactoryAPI, statusFactoryAPI } from '@/testing/factories';
import { immutableFromJS } from 'mastodon/utils/immutable_map_of';

import { muteAccountSuccess } from '../actions/accounts';
import {
  expandBookmarkedStatusesSuccess,
  fetchBookmarkedStatusesFail,
  fetchBookmarkedStatusesRequest,
  fetchBookmarkedStatusesSuccess,
} from '../actions/bookmarks';
import { importStatuses } from '../actions/importer';
import { normalizeStatus } from '../actions/importer/normalizer';
import { favouriteSuccess, unfavouriteSuccess } from '../actions/interactions';
import { fetchQuotes } from '../actions/interactions_typed';
import { fetchTrendingStatusesSuccess } from '../actions/trends';
import type { StatusListKey, StatusListsState } from '../models/status_list';

import statusLists from './status_lists';
import statuses from './statuses';

const apiStatuses = (...ids: string[]) =>
  ids.map((id) => statusFactoryAPI({ id }));

const items = (state: StatusListsState, list: StatusListKey) =>
  state.get(list).get('items').toArray();

const status = (id: string) =>
  immutableFromJS(normalizeStatus(statusFactoryAPI({ id }), undefined, {}));

describe('status_lists reducer', () => {
  test('starts with the empty lists', () => {
    expect(statusLists(undefined, { type: 'INIT' }).toJS()).toEqual({
      favourites: { next: null, loaded: false, items: [] },
      bookmarks: { next: null, loaded: false, items: [] },
      pins: { next: null, loaded: false, items: [] },
      trending: { next: null, loaded: false, items: [] },
      quotes: { next: null, loaded: false, items: [], statusId: null },
    });
  });

  test('loads a list and its next page', () => {
    let state = statusLists(undefined, fetchBookmarkedStatusesRequest());
    expect(state.getIn(['bookmarks', 'isLoading'])).toBe(true);

    state = statusLists(
      state,
      fetchBookmarkedStatusesSuccess(apiStatuses('3', '2'), 'https://next'),
    );
    expect(items(state, 'bookmarks')).toEqual(['3', '2']);
    expect(state.get('bookmarks')?.toJS()).toMatchObject({
      next: 'https://next',
      loaded: true,
      isLoading: false,
    });

    state = statusLists(
      state,
      expandBookmarkedStatusesSuccess(apiStatuses('2', '1'), null),
    );
    expect(items(state, 'bookmarks')).toEqual(['3', '2', '1']);
    expect(state.getIn(['bookmarks', 'next'])).toBeNull();

    expect(
      statusLists(state, fetchBookmarkedStatusesFail(new Error())).getIn([
        'bookmarks',
        'isLoading',
      ]),
    ).toBe(false);
  });

  test('prepends a new favourite once, and removes an unfavourited one', () => {
    let state = statusLists(undefined, favouriteSuccess(status('1')));
    state = statusLists(state, favouriteSuccess(status('2')));
    const same = statusLists(state, favouriteSuccess(status('1')));
    expect(same).toBe(state);
    expect(items(state, 'favourites')).toEqual(['2', '1']);

    state = statusLists(state, unfavouriteSuccess(status('1')));
    expect(items(state, 'favourites')).toEqual(['2']);
  });

  test('removes a muted account from the trending statuses', () => {
    let state = statusLists(
      undefined,
      fetchTrendingStatusesSuccess(apiStatuses('1', '2'), null),
    );
    const stored = statuses(
      undefined,
      importStatuses(
        apiStatuses('1', '2').map((apiStatus) =>
          normalizeStatus(
            {
              ...apiStatus,
              account: {
                ...apiStatus.account,
                id: apiStatus.id === '2' ? 'b' : 'a',
              },
            },
            undefined,
            {},
          ),
        ),
      ),
    );
    state = statusLists(
      state,
      muteAccountSuccess({
        relationship: relationshipsFactoryAPI({ id: 'b', muting: true }),
        statuses: stored,
      }),
    );
    expect(items(state, 'trending')).toEqual(['1']);
  });

  describe('quotes', () => {
    const page = (ids: string[], next?: string) => ({
      statuses: apiStatuses(...ids),
      links: LinkHeader.parse(next ? `<${next}>; rel="next"` : ''),
    });

    test('keeps the quoted status of the list', () => {
      const state = statusLists(
        undefined,
        fetchQuotes.pending('request', { statusId: '9' }),
      );
      expect(state.getIn(['quotes', 'statusId'])).toBe('9');
      expect(state.getIn(['quotes', 'isLoading'])).toBe(true);
    });

    test('stores the first page with its next URL, and appends the next one', () => {
      let state = statusLists(
        undefined,
        fetchQuotes.fulfilled(
          { ...page(['3', '2'], 'https://example.com/next'), replace: true },
          'request',
          { statusId: '9' },
        ),
      );
      expect(items(state, 'quotes')).toEqual(['3', '2']);
      expect(state.getIn(['quotes', 'next'])).toBe('https://example.com/next');
      expect(state.getIn(['quotes', 'statusId'])).toBe('9');
      // Not on the lists' map itself.
      expect(state.keySeq().toArray()).toEqual([
        'favourites',
        'bookmarks',
        'pins',
        'trending',
        'quotes',
      ]);

      state = statusLists(
        state,
        fetchQuotes.fulfilled({ ...page(['1']), replace: false }, 'request', {
          statusId: '9',
          next: 'https://example.com/next',
        }),
      );
      expect(items(state, 'quotes')).toEqual(['3', '2', '1']);
      expect(state.getIn(['quotes', 'next'])).toBeNull();
    });
  });
});
