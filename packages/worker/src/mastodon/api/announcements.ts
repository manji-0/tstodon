import {
  apiRequestDelete,
  apiRequestGet,
  apiRequestPost,
  apiRequestPut,
} from 'mastodon/api';
import type { ApiAnnouncementJSON } from 'mastodon/api_types/announcements';

export const apiGetAnnouncements = () =>
  apiRequestGet<ApiAnnouncementJSON[]>('v1/announcements');

export const apiDismissAnnouncement = (announcementId: string) =>
  apiRequestPost(`v1/announcements/${announcementId}/dismiss`);

export const apiAddAnnouncementReaction = (
  announcementId: string,
  name: string,
) =>
  apiRequestPut(
    `v1/announcements/${announcementId}/reactions/${encodeURIComponent(name)}`,
  );

export const apiRemoveAnnouncementReaction = (
  announcementId: string,
  name: string,
) =>
  apiRequestDelete(
    `v1/announcements/${announcementId}/reactions/${encodeURIComponent(name)}`,
  );
