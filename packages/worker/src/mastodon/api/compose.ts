import type { ApiUpdateMediaParams } from '@tstodon/api';
import { apiRequestPut } from 'mastodon/api';
import type { ApiMediaAttachmentJSON } from 'mastodon/api_types/media_attachments';

export const apiUpdateMedia = (id: string, params?: ApiUpdateMediaParams) =>
  apiRequestPut<ApiMediaAttachmentJSON>(`v1/media/${id}`, params);
