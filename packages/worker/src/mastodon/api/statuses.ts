import type {
  ApiCreateStatusParams,
  ApiDeleteStatusParams,
  ApiStatusEditJSON,
  ApiTranslationJSON,
  ApiUpdateStatusParams,
} from '@tstodon/api';
import api, {
  apiRequestDelete,
  apiRequestGet,
  apiRequestPost,
  apiRequestPut,
  getAsyncRefreshHeader,
} from 'mastodon/api';
import type {
  ApiContextJSON,
  ApiStatusJSON,
  ApiStatusSourceJSON,
} from 'mastodon/api_types/statuses';

import type { ApiQuotePolicy } from '../api_types/quotes';

export const apiGetContext = async (statusId: string) => {
  const response = await api().request<ApiContextJSON>({
    method: 'GET',
    url: `/api/v1/statuses/${statusId}/context`,
  });

  return {
    context: response.data,
    refresh: getAsyncRefreshHeader(response),
  };
};

export const apiSetQuotePolicy = async (
  statusId: string,
  policy: ApiQuotePolicy,
) => {
  return apiRequestPut<ApiStatusJSON>(
    `v1/statuses/${statusId}/interaction_policy`,
    {
      quote_approval_policy: policy,
    },
  );
};

export const apiGetStatus = (statusId: string) =>
  apiRequestGet<ApiStatusJSON>(`v1/statuses/${statusId}`);

export const apiGetStatusSource = (statusId: string) =>
  apiRequestGet<ApiStatusSourceJSON>(`v1/statuses/${statusId}/source`);

export const apiGetStatusHistory = (statusId: string) =>
  apiRequestGet<ApiStatusEditJSON[]>(`v1/statuses/${statusId}/history`);

/**
 * Posts a new status (`statusId` `null`) or replaces the revision of an
 * existing one. The idempotency key makes a retried post answer with the
 * status the first attempt created.
 */
export const apiSubmitStatus = async ({
  statusId,
  params,
  idempotencyKey,
}: {
  statusId: string | null;
  params: ApiCreateStatusParams | ApiUpdateStatusParams;
  idempotencyKey?: string | null;
}) => {
  const response = await api().request<ApiStatusJSON>({
    url:
      statusId === null ? '/api/v1/statuses' : `/api/v1/statuses/${statusId}`,
    method: statusId === null ? 'post' : 'put',
    data: params,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
  });

  return response.data;
};

/** The deleted status, with its source `text` for a redraft. */
export const apiDeleteStatus = (
  statusId: string,
  params: ApiDeleteStatusParams,
) => apiRequestDelete<ApiStatusJSON>(`v1/statuses/${statusId}`, params);

export const apiMuteStatus = (statusId: string) =>
  apiRequestPost<ApiStatusJSON>(`v1/statuses/${statusId}/mute`);

export const apiUnmuteStatus = (statusId: string) =>
  apiRequestPost<ApiStatusJSON>(`v1/statuses/${statusId}/unmute`);

export const apiTranslateStatus = (statusId: string) =>
  apiRequestPost<ApiTranslationJSON>(`v1/statuses/${statusId}/translate`);
