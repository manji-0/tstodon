import type {
  ApiCreateFilterStatusParams,
  ApiFilterJSON,
  ApiFilterParams,
  ApiFilterStatusJSON,
} from '@tstodon/api';
import { apiRequestGet, apiRequestPost } from 'mastodon/api';

export const apiGetFilters = () => apiRequestGet<ApiFilterJSON[]>('v2/filters');

export const apiCreateFilter = (params: ApiFilterParams) =>
  apiRequestPost<ApiFilterJSON>('v2/filters', params);

export const apiCreateFilterStatus = (
  filterId: string,
  params: ApiCreateFilterStatusParams,
) =>
  apiRequestPost<ApiFilterStatusJSON>(`v2/filters/${filterId}/statuses`, params);
