import type {
  ApiConversationJSON,
  ApiGetConversationsParams,
} from '@tstodon/api';
import api, { apiRequestDelete, apiRequestPost, getLinks } from 'mastodon/api';

export const apiGetConversations = async (
  params: ApiGetConversationsParams,
) => {
  const response = await api().get<ApiConversationJSON[]>(
    '/api/v1/conversations',
    { params },
  );

  return {
    conversations: response.data,
    next: getLinks(response).refs.find((link) => link.rel === 'next')?.uri,
  };
};

export const apiMarkConversationRead = (conversationId: string) =>
  apiRequestPost<ApiConversationJSON>(
    `v1/conversations/${conversationId}/read`,
  );

export const apiDeleteConversation = (conversationId: string) =>
  apiRequestDelete(`v1/conversations/${conversationId}`);
