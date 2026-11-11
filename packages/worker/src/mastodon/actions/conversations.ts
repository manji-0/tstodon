import type {
  ApiConversationJSON,
  ApiGetConversationsParams,
} from '@tstodon/api';
import {
  apiDeleteConversation,
  apiGetConversations,
  apiMarkConversationRead,
} from 'mastodon/api/conversations';
import type { AppDispatch, GetState } from 'mastodon/store';

import {
  importFetchedAccounts,
  importFetchedStatuses,
  importFetchedStatus,
} from './importer';

export const CONVERSATIONS_MOUNT   = 'CONVERSATIONS_MOUNT' as const;
export const CONVERSATIONS_UNMOUNT = 'CONVERSATIONS_UNMOUNT' as const;

export const CONVERSATIONS_FETCH_REQUEST = 'CONVERSATIONS_FETCH_REQUEST' as const;
export const CONVERSATIONS_FETCH_SUCCESS = 'CONVERSATIONS_FETCH_SUCCESS' as const;
export const CONVERSATIONS_FETCH_FAIL    = 'CONVERSATIONS_FETCH_FAIL' as const;
export const CONVERSATIONS_UPDATE        = 'CONVERSATIONS_UPDATE' as const;

export const CONVERSATIONS_READ = 'CONVERSATIONS_READ' as const;

export const CONVERSATIONS_DELETE_REQUEST = 'CONVERSATIONS_DELETE_REQUEST';
export const CONVERSATIONS_DELETE_SUCCESS = 'CONVERSATIONS_DELETE_SUCCESS' as const;
export const CONVERSATIONS_DELETE_FAIL    = 'CONVERSATIONS_DELETE_FAIL';

/** Dispatched by `markConversationRead`. */
export interface ConversationsReadAction {
  type: typeof CONVERSATIONS_READ;
  id: string;
}

/** Dispatched by `updateConversations` (a streamed conversation). */
export interface ConversationsUpdateAction {
  type: typeof CONVERSATIONS_UPDATE;
  conversation: ApiConversationJSON;
}

export const mountConversations = () => ({
  type: CONVERSATIONS_MOUNT,
});

export const unmountConversations = () => ({
  type: CONVERSATIONS_UNMOUNT,
});

export const markConversationRead = (conversationId: string) => (dispatch: AppDispatch) => {
  dispatch({
    type: CONVERSATIONS_READ,
    id: conversationId,
  } satisfies ConversationsReadAction);

  void apiMarkConversationRead(conversationId);
};

export const expandConversations = ({ maxId }: { maxId?: string } = {}) => (dispatch: AppDispatch, getState: GetState) => {
  dispatch(expandConversationsRequest());

  const params: ApiGetConversationsParams = { max_id: maxId };

  if (!maxId) {
    const lastStatus: unknown = getState().conversations.getIn(['items', 0, 'last_status']);
    params.since_id = typeof lastStatus === 'string' ? lastStatus : undefined;
  }

  const isLoadingRecent = !!params.since_id;

  apiGetConversations(params)
    .then(({ conversations, next }) => {
      dispatch(importFetchedAccounts(conversations.reduce<ApiConversationJSON['accounts']>((aggr, item) => aggr.concat(item.accounts), [])));
      dispatch(importFetchedStatuses(conversations.map(item => item.last_status).filter(x => !!x)));
      dispatch(expandConversationsSuccess(conversations, next ?? null, isLoadingRecent));
    })
    .catch((err: unknown) => dispatch(expandConversationsFail(err)));
};

export const expandConversationsRequest = () => ({
  type: CONVERSATIONS_FETCH_REQUEST,
});

export const expandConversationsSuccess = (conversations: ApiConversationJSON[], next: string | null, isLoadingRecent: boolean) => ({
  type: CONVERSATIONS_FETCH_SUCCESS,
  conversations,
  next,
  isLoadingRecent,
});

export const expandConversationsFail = (error: unknown) => ({
  type: CONVERSATIONS_FETCH_FAIL,
  error,
});

export const updateConversations = (conversation: ApiConversationJSON) => (dispatch: AppDispatch) => {
  dispatch(importFetchedAccounts(conversation.accounts));

  if (conversation.last_status) {
    dispatch(importFetchedStatus(conversation.last_status));
  }

  dispatch({
    type: CONVERSATIONS_UPDATE,
    conversation,
  } satisfies ConversationsUpdateAction);
};

export const deleteConversation = (conversationId: string) => (dispatch: AppDispatch) => {
  dispatch(deleteConversationRequest(conversationId));

  apiDeleteConversation(conversationId)
    .then(() => dispatch(deleteConversationSuccess(conversationId)))
    .catch((error: unknown) => dispatch(deleteConversationFail(conversationId, error)));
};

export const deleteConversationRequest = (id: string) => ({
  type: CONVERSATIONS_DELETE_REQUEST,
  id,
});

export const deleteConversationSuccess = (id: string) => ({
  type: CONVERSATIONS_DELETE_SUCCESS,
  id,
});

export const deleteConversationFail = (id: string, error: unknown) => ({
  type: CONVERSATIONS_DELETE_FAIL,
  id,
  error,
});
