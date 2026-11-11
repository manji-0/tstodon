import { createReducer } from '@reduxjs/toolkit';
import { List as ImmutableList } from 'immutable';

import type { ApiConversationJSON } from '@tstodon/api';
import {
  blockAccountSuccess,
  muteAccountSuccess,
} from 'mastodon/actions/accounts';
import { blockDomainSuccess } from 'mastodon/actions/domain_blocks';

import {
  CONVERSATIONS_MOUNT,
  CONVERSATIONS_UNMOUNT,
  CONVERSATIONS_FETCH_REQUEST,
  CONVERSATIONS_FETCH_SUCCESS,
  CONVERSATIONS_FETCH_FAIL,
  CONVERSATIONS_UPDATE,
  CONVERSATIONS_READ,
  CONVERSATIONS_DELETE_SUCCESS,
} from '../actions/conversations';
import type {
  ConversationsReadAction,
  ConversationsUpdateAction,
  deleteConversationSuccess,
  expandConversationsFail,
  expandConversationsRequest,
  expandConversationsSuccess,
  mountConversations,
  unmountConversations,
} from '../actions/conversations';
import { compareId } from '../compare_id';

import { immutableMapOf } from '../utils/immutable_map_of';
import type { ImmutableMapOf } from '../utils/immutable_map_of';

import { matchAction } from './match_action';

/** A conversation, with its accounts and last status by id. */
export interface ConversationFields {
  id: string;
  unread: boolean;
  accounts: ImmutableList<string>;
  last_status: string | null;
}

/** A conversation: an Immutable `Map` of `ConversationFields`. */
export type Conversation = ImmutableMapOf<ConversationFields>;

/** The direct messages column: `mounted` counts its mounted columns. */
export interface ConversationsFields {
  items: ImmutableList<Conversation>;
  isLoading: boolean;
  hasMore: boolean;
  mounted: number;
}

export type ConversationsState = ImmutableMapOf<ConversationsFields>;

const initialState: ConversationsState = immutableMapOf<ConversationsFields>({
  items: ImmutableList<Conversation>(),
  isLoading: false,
  hasMore: true,
  mounted: 0,
});

const conversationToMap = (item: ApiConversationJSON): Conversation =>
  immutableMapOf<ConversationFields>({
    id: item.id,
    unread: item.unread,
    accounts: ImmutableList(item.accounts.map((a) => a.id)),
    last_status: item.last_status ? item.last_status.id : null,
  });

const updateItems = (
  state: ConversationsState,
  updater: (items: ImmutableList<Conversation>) => ImmutableList<Conversation>,
) => state.update('items', updater);

const updateConversation = (
  state: ConversationsState,
  item: ApiConversationJSON,
) =>
  updateItems(state, (list) => {
    const index = list.findIndex((x) => x.get('id') === item.id);
    const newItem = conversationToMap(item);

    if (index === -1) {
      return list.unshift(newItem);
    } else {
      return list.set(index, newItem);
    }
  });

const expandNormalizedConversations = (
  state: ConversationsState,
  conversations: ApiConversationJSON[],
  next: string | null,
  isLoadingRecent: boolean,
) => {
  let items = ImmutableList(conversations.map(conversationToMap));

  return state.withMutations((mutable) => {
    if (!items.isEmpty()) {
      updateItems(mutable, (list) => {
        list = list.map((oldItem) => {
          const newItemIndex = items.findIndex(
            (x) => x.get('id') === oldItem.get('id'),
          );
          const newItem = items.get(newItemIndex);

          if (newItemIndex === -1 || !newItem) {
            return oldItem;
          }

          items = items.delete(newItemIndex);

          return newItem;
        });

        list = list.concat(items);

        return list.sortBy(
          (item) => item.get('last_status'),
          (a, b) => {
            if (a === null || b === null) {
              return -1;
            }

            return compareId(a, b) * -1;
          },
        );
      });
    }

    if (!next && !isLoadingRecent) {
      mutable.set('hasMore', false);
    }

    mutable.set('isLoading', false);
  });
};

const filterConversations = (
  state: ConversationsState,
  accountIds: string[],
) => {
  return updateItems(state, (list) =>
    list.filterNot((item) =>
      item
        .get('accounts')
        .some((accountId) => accountIds.includes(accountId)),
    ),
  );
};

const updateMounted = (state: ConversationsState, change: number) =>
  state.update('mounted', (mounted) => mounted + change);

const isFetchRequest = matchAction<
  ReturnType<typeof expandConversationsRequest>
>(CONVERSATIONS_FETCH_REQUEST);
const isFetchFail = matchAction<ReturnType<typeof expandConversationsFail>>(
  CONVERSATIONS_FETCH_FAIL,
);
const isFetchSuccess = matchAction<
  ReturnType<typeof expandConversationsSuccess>
>(CONVERSATIONS_FETCH_SUCCESS);
const isUpdate = matchAction<ConversationsUpdateAction>(CONVERSATIONS_UPDATE);
const isMount =
  matchAction<ReturnType<typeof mountConversations>>(CONVERSATIONS_MOUNT);
const isUnmount = matchAction<ReturnType<typeof unmountConversations>>(
  CONVERSATIONS_UNMOUNT,
);
const isRead = matchAction<ConversationsReadAction>(CONVERSATIONS_READ);
const isDeleteSuccess = matchAction<
  ReturnType<typeof deleteConversationSuccess>
>(CONVERSATIONS_DELETE_SUCCESS);

const conversationsReducer = createReducer(initialState, (builder) => {
  builder
    .addCase(blockAccountSuccess, (state, action) =>
      filterConversations(state, [action.payload.relationship.id]),
    )
    .addCase(muteAccountSuccess, (state, action) =>
      filterConversations(state, [action.payload.relationship.id]),
    )
    .addCase(blockDomainSuccess, (state, action) =>
      filterConversations(state, action.payload.accounts),
    )
    .addMatcher(isFetchRequest, (state) => state.set('isLoading', true))
    .addMatcher(isFetchFail, (state) => state.set('isLoading', false))
    .addMatcher(isFetchSuccess, (state, action) =>
      expandNormalizedConversations(
        state,
        action.conversations,
        action.next,
        action.isLoadingRecent,
      ),
    )
    .addMatcher(isUpdate, (state, action) =>
      updateConversation(state, action.conversation),
    )
    .addMatcher(isMount, (state) => updateMounted(state, 1))
    .addMatcher(isUnmount, (state) => updateMounted(state, -1))
    .addMatcher(isRead, (state, action) =>
      updateItems(state, (list) =>
        list.map((item) => {
          if (item.get('id') === action.id) {
            return item.set('unread', false);
          }

          return item;
        }),
      ),
    )
    .addMatcher(isDeleteSuccess, (state, action) =>
      updateItems(state, (list) =>
        list.filterNot((item) => item.get('id') === action.id),
      ),
    );
});

export default conversationsReducer;
