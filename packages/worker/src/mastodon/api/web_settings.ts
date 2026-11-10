import type { ApiUpdateWebSettingsParams } from '@tstodon/api';
import { apiRequest } from 'mastodon/api';

/** `PUT /api/web/settings`: the UI's own settings, saved whole. */
export const apiUpdateWebSettings = (data: ApiUpdateWebSettingsParams) =>
  apiRequest('PUT', 'web/settings', { data });
