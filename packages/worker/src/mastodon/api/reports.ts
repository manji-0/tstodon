import type { ApiCreateReportParams } from '@tstodon/api';
import { apiRequestPost } from 'mastodon/api';
import type { ApiReportJSON } from 'mastodon/api_types/reports';

export const apiSubmitReport = (params: ApiCreateReportParams) =>
  apiRequestPost<ApiReportJSON>('v1/reports', params);
