import { List as ImmutableList } from 'immutable';

import type { ApiFeaturedTagJSON } from '@tstodon/api';
import { accountFactoryAPI } from '@/testing/factories';

import {
  authorizeFollowRequestSuccess,
  expandFollowersRequest,
  expandFollowersSuccess,
  fetchEndorsedAccounts,
  fetchFollowersFail,
  fetchFollowersRequest,
  fetchFollowersSuccess,
  fetchFollowRequestsSuccess,
  rejectFollowRequestSuccess,
} from '../actions/accounts';
import { fetchBlocksRequest, fetchBlocksSuccess } from '../actions/blocks';
import { expandDirectory, fetchDirectory } from '../actions/directory';
import { fetchFeaturedTags } from '../actions/featured_tags';
import { fetchReblogsSuccess } from '../actions/interactions';
import { notificationsUpdate } from '../actions/notifications';

import userLists from './user_lists';

const accounts = (...ids: string[]) =>
  ids.map((id) => accountFactoryAPI({ id }));

const featuredTag = (
  id: string,
  statuses_count: string,
): ApiFeaturedTagJSON => ({
  id,
  name: `tag${id}`,
  url: `https://example.com/tags/tag${id}`,
  statuses_count,
  last_status_at: null,
});

const emptyList = { next: null, isLoading: false, items: [] };

describe('user_lists reducer', () => {
  it('starts with the single lists and empty maps by id', () => {
    expect(userLists(undefined, { type: 'INIT' }).toJS()).toEqual({
      followers: {},
      following: {},
      reblogged_by: {},
      favourited_by: {},
      follow_requests: emptyList,
      blocks: emptyList,
      mutes: emptyList,
      featured_tags: {},
    });
  });

  it('loads and pages an account’s followers', () => {
    let state = userLists(undefined, fetchFollowersRequest('1'));
    expect(state.get('followers').get('1')?.toJS()).toEqual({
      isLoading: true,
    });

    state = userLists(
      state,
      fetchFollowersSuccess('1', accounts('2', '3'), 'https://next'),
    );
    expect(state.get('followers').get('1')?.toJS()).toEqual({
      next: 'https://next',
      isLoading: false,
      items: ['2', '3'],
    });

    state = userLists(state, expandFollowersRequest('1'));
    expect(state.get('followers').get('1')?.get('isLoading')).toBe(true);

    state = userLists(state, expandFollowersSuccess('1', accounts('4'), null));
    expect(state.get('followers').get('1')?.toJS()).toEqual({
      next: null,
      isLoading: false,
      items: ['2', '3', '4'],
    });

    state = userLists(state, fetchFollowersFail('1', new Error()));
    expect(state.get('followers').get('1')?.get('isLoading')).toBe(false);
  });

  it('keeps the lists by status', () => {
    const state = userLists(
      undefined,
      fetchReblogsSuccess('9', accounts('2'), null),
    );

    expect(state.get('reblogged_by').get('9')?.get('items')).toEqual(
      ImmutableList(['2']),
    );
  });

  it('adds a streamed follow request first, and removes handled ones', () => {
    let state = userLists(
      undefined,
      fetchFollowRequestsSuccess(accounts('2', '3'), null),
    );
    state = userLists(
      state,
      notificationsUpdate({
        notification: {
          id: '10',
          type: 'follow_request',
          created_at: '2025-01-01T00:00:00.000Z',
          group_key: 'ungrouped-10',
          account: accountFactoryAPI({ id: '3' }),
        },
        playSound: false,
      }),
    );
    expect(state.get('follow_requests').get('items')?.toArray()).toEqual([
      '3',
      '2',
    ]);

    state = userLists(state, authorizeFollowRequestSuccess({ id: '3' }));
    state = userLists(state, rejectFollowRequestSuccess({ id: '2' }));
    expect(state.get('follow_requests').get('items')?.toArray()).toEqual([]);
  });

  it('loads the blocks', () => {
    let state = userLists(undefined, fetchBlocksRequest());
    expect(state.get('blocks').get('isLoading')).toBe(true);

    state = userLists(state, fetchBlocksSuccess(accounts('5'), 'https://next'));
    expect(state.get('blocks').toJS()).toEqual({
      next: 'https://next',
      isLoading: false,
      items: ['5'],
    });
  });

  it('loads the directory', () => {
    let state = userLists(
      undefined,
      fetchDirectory.pending('r1', { order: 'active' }),
    );
    expect(state.get('directory')?.toJS()).toEqual({ isLoading: true });

    state = userLists(
      state,
      fetchDirectory.fulfilled(
        { accounts: accounts('1', '2'), isLast: false },
        'r1',
        { order: 'active' },
      ),
    );
    expect(state.get('directory')?.toJS()).toEqual({
      next: true,
      isLoading: false,
      items: ['1', '2'],
    });

    state = userLists(
      state,
      expandDirectory.fulfilled({ accounts: accounts('3'), isLast: true }, 'r2', {
        order: 'active',
      }),
    );
    expect(state.get('directory')?.toJS()).toEqual({
      next: null,
      isLoading: false,
      items: ['1', '2', '3'],
    });
  });

  it('loads an account’s endorsements', () => {
    let state = userLists(
      undefined,
      fetchEndorsedAccounts.pending('r1', { accountId: '1' }),
    );
    expect(state.get('featured_accounts')?.get('1')?.toJS()).toEqual({
      isLoading: true,
    });

    state = userLists(
      state,
      fetchEndorsedAccounts.fulfilled(accounts('2'), 'r1', { accountId: '1' }),
    );
    expect(state.get('featured_accounts')?.get('1')?.toJS()).toEqual({
      next: undefined,
      isLoading: false,
      items: ['2'],
    });
  });

  it('loads an account’s featured tags, the most used first', () => {
    const state = userLists(
      undefined,
      fetchFeaturedTags.fulfilled(
        [featuredTag('1', '9'), featuredTag('2', '10')],
        'r1',
        { accountId: '7' },
      ),
    );

    expect(state.get('featured_tags').get('7')?.toJS()).toEqual({
      isLoading: false,
      items: [
        { ...featuredTag('2', '10'), accountId: '7' },
        { ...featuredTag('1', '9'), accountId: '7' },
      ],
    });
  });
});
