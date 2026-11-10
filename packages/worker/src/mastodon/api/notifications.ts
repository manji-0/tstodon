import type {
  ApiGetGroupedNotificationsParams,
  ApiGetNotificationRequestsParams,
  ApiGetNotificationsParams,
  ApiNotificationRequestIdsParams,
} from '@tstodon/api';
import api, {
  apiRequest,
  getLinks,
  apiRequestGet,
  apiRequestPost,
} from 'mastodon/api';
import type {
  ApiNotificationGroupsResultJSON,
  ApiNotificationRequestJSON,
  ApiNotificationJSON,
} from 'mastodon/api_types/notifications';

export const apiFetchNotifications = async (
  params?: ApiGetNotificationsParams,
  url?: string,
) => {
  const response = await api().request<ApiNotificationJSON[]>({
    method: 'GET',
    url: url ?? '/api/v1/notifications',
    params,
  });

  return {
    notifications: response.data,
    links: getLinks(response),
  };
};

export const apiFetchNotificationGroups = async (
  params?: ApiGetGroupedNotificationsParams,
) => {
  const response = await api().request<ApiNotificationGroupsResultJSON>({
    method: 'GET',
    url: '/api/v2/notifications',
    params,
  });

  const { statuses, accounts, notification_groups } = response.data;

  return {
    statuses,
    accounts,
    notifications: notification_groups,
    links: getLinks(response),
  };
};

export const apiClearNotifications = () =>
  apiRequest<undefined>('POST', 'v1/notifications/clear');

export const apiFetchNotificationRequests = async (
  params?: ApiGetNotificationRequestsParams,
  url?: string,
) => {
  const response = await api().request<ApiNotificationRequestJSON[]>({
    method: 'GET',
    url: url ?? '/api/v1/notifications/requests',
    params,
  });

  return {
    requests: response.data,
    links: getLinks(response),
  };
};

export const apiFetchNotificationRequest = async (id: string) => {
  return apiRequestGet<ApiNotificationRequestJSON>(
    `v1/notifications/requests/${id}`,
  );
};

export const apiAcceptNotificationRequest = async (id: string) => {
  return apiRequestPost(`v1/notifications/requests/${id}/accept`);
};

export const apiDismissNotificationRequest = async (id: string) => {
  return apiRequestPost(`v1/notifications/requests/${id}/dismiss`);
};

export const apiAcceptNotificationRequests = async (id: string[]) => {
  return apiRequestPost('v1/notifications/requests/accept', {
    id,
  } satisfies ApiNotificationRequestIdsParams);
};

export const apiDismissNotificationRequests = async (id: string[]) => {
  return apiRequestPost('v1/notifications/requests/dismiss', {
    id,
  } satisfies ApiNotificationRequestIdsParams);
};
