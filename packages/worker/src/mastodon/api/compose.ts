import type { AxiosProgressEvent } from 'axios';

import type { ApiUpdateMediaParams, ApiUploadMediaParams } from '@tstodon/api';
import api, { apiRequestPut } from 'mastodon/api';
import type { ApiMediaAttachmentJSON } from 'mastodon/api_types/media_attachments';

export const apiUpdateMedia = (id: string, params?: ApiUpdateMediaParams) =>
  apiRequestPut<ApiMediaAttachmentJSON>(`v1/media/${id}`, params);

type MediaFormFields = Record<string, string | Blob | null | undefined>;

/** A multipart body from the params' string and file fields. */
const mediaFormData = (fields: MediaFormFields) => {
  const data = new FormData();

  Object.entries(fields).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      data.append(key, value);
    }
  });

  return data;
};

/**
 * Uploads an attachment. The response's status tells whether it is ready
 * (200) or still processing (202, poll `apiGetMedia` until it answers 200).
 */
export const apiUploadMedia = (
  params: ApiUploadMediaParams & { file: File },
  onUploadProgress?: (event: AxiosProgressEvent) => void,
) =>
  api().post<ApiMediaAttachmentJSON>(
    '/api/v2/media',
    mediaFormData({
      file: params.file,
      description: params.description,
      focus: params.focus,
    }),
    { onUploadProgress },
  );

/** An attachment of the viewer's: 206 while it is still processing. */
export const apiGetMedia = (id: string) =>
  api().get<ApiMediaAttachmentJSON>(`/api/v1/media/${id}`);

/** Replaces the thumbnail of an attachment not yet posted. */
export const apiUploadMediaThumbnail = async (
  id: string,
  params: ApiUpdateMediaParams & { thumbnail: File },
  onUploadProgress?: (event: AxiosProgressEvent) => void,
) => {
  const response = await api().put<ApiMediaAttachmentJSON>(
    `/api/v1/media/${id}`,
    mediaFormData({
      thumbnail: params.thumbnail,
      description: params.description,
      focus: params.focus,
    }),
    { onUploadProgress },
  );

  return response.data;
};
