import { Map as ImmutableMap } from 'immutable';

import type { ApiConversationJSON } from '@tstodon/api';
import {
  accountFactoryAPI,
  relationshipsFactoryAPI,
  statusFactoryAPI,
} from '@/testing/factories';

import { blockAccountSuccess } from '../actions/accounts';
import {
  CONVERSATIONS_READ,
  CONVERSATIONS_UPDATE,
  deleteConversationSuccess,
  expandConversationsRequest,
  expandConversationsSuccess,
  mountConversations,
  unmountConversations,
} from '../actions/conversations';
import type {
  ConversationsReadAction,
  ConversationsUpdateAction,
} from '../actions/conversations';
import { blockDomainSuccess } from '../actions/domain_blocks';

import conversations, { getConversationItems } from './conversations';
import type { ConversationsState } from './conversations';

const conversation = (
  id: string,
  lastStatusId: string | null,
  accountIds = ['a'],
): ApiConversationJSON => ({
  id,
  unread: true,
  accounts: accountIds.map((accountId) => accountFactoryAPI({ id: accountId })),
  last_status: lastStatusId ? statusFactoryAPI({ id: lastStatusId }) : null,
});

const ids = (state: ConversationsState) =>
  getConversationItems(state)
    .map((item) => item.get('id'))
    .toArray();

const loaded = (...items: ApiConversationJSON[]) =>
  conversations(undefined, expandConversationsSuccess(items, 'next', false));

describe('conversations reducer', () => {
  test('starts empty', () => {
    expect(conversations(undefined, { type: 'INIT' }).toJS()).toEqual({
      items: [],
      isLoading: false,
      hasMore: true,
      mounted: 0,
    });
  });

  test('stores the conversations with their accounts and last status by id', () => {
    let state = conversations(undefined, expandConversationsRequest());
    expect(state.get('isLoading')).toBe(true);

    state = conversations(
      state,
      expandConversationsSuccess(
        [conversation('c1', '1', ['a', 'b'])],
        null,
        false,
      ),
    );
    expect(state.toJS()).toEqual({
      items: [
        { id: 'c1', unread: true, accounts: ['a', 'b'], last_status: '1' },
      ],
      isLoading: false,
      hasMore: false,
      mounted: 0,
    });
  });

  test('merges a page, newest last status first', () => {
    let state = loaded(conversation('c1', '1'), conversation('c2', '5'));
    state = conversations(
      state,
      expandConversationsSuccess(
        [conversation('c1', '7'), conversation('c3', '3')],
        'next',
        true,
      ),
    );
    expect(ids(state)).toEqual(['c1', 'c2', 'c3']);
    expect(state.get('hasMore')).toBe(true);
  });

  test('puts a streamed conversation first, or replaces it', () => {
    let state = loaded(conversation('c1', '1'));
    const update = (item: ApiConversationJSON) =>
      ({
        type: CONVERSATIONS_UPDATE,
        conversation: item,
      }) satisfies ConversationsUpdateAction;

    state = conversations(state, update(conversation('c2', '2')));
    expect(ids(state)).toEqual(['c2', 'c1']);

    state = conversations(state, update(conversation('c1', '3')));
    expect(ids(state)).toEqual(['c2', 'c1']);
    expect(state.getIn(['items', 1, 'last_status'])).toBe('3');
  });

  test('marks a conversation as read, and deletes it', () => {
    let state = loaded(conversation('c1', '1'), conversation('c2', '2'));
    state = conversations(state, {
      type: CONVERSATIONS_READ,
      id: 'c1',
    } satisfies ConversationsReadAction);
    // Newest last status first: c2, then c1.
    expect(state.getIn(['items', 0, 'unread'])).toBe(true);
    expect(state.getIn(['items', 1, 'unread'])).toBe(false);

    state = conversations(state, deleteConversationSuccess('c1'));
    expect(ids(state)).toEqual(['c2']);
  });

  test('counts its mounted columns', () => {
    let state = conversations(undefined, mountConversations());
    state = conversations(state, mountConversations());
    state = conversations(state, unmountConversations());
    expect(state.get('mounted')).toBe(1);
  });

  test('removes the conversations with a blocked account or domain', () => {
    let state = loaded(
      conversation('c1', '1', ['a']),
      conversation('c2', '2', ['b']),
      conversation('c3', '3', ['c', 'd']),
    );
    state = conversations(
      state,
      blockAccountSuccess({
        relationship: relationshipsFactoryAPI({ id: 'b' }),
        statuses: ImmutableMap(),
      }),
    );
    expect(ids(state)).toEqual(['c3', 'c1']);

    state = conversations(
      state,
      blockDomainSuccess({ domain: 'example.com', accounts: ['d'] }),
    );
    expect(ids(state)).toEqual(['c1']);
  });
});
