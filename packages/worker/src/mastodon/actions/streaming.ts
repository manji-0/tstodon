import type {
  ApiMastodonNotificationJSON,
  ApiNotificationJSON,
  ApiStatusJSON,
  ApiStreamingEventName,
  ApiStreamingPayloadJSON,
} from '@tstodon/api';
import { isMastodonNotificationType } from '@tstodon/api/values';
import type { AppDispatch, GetState } from 'mastodon/store';

import { getLocale } from '../locales';
import { connectStream } from '../stream';
import type { StreamParams } from '../stream';

import {
  fetchAnnouncements,
  updateAnnouncements,
  updateReaction as updateAnnouncementsReaction,
  deleteAnnouncement,
} from './announcements';
import { updateConversations } from './conversations';
import { processNewNotificationForGroups, refreshStaleNotificationGroups, pollRecentNotifications as pollRecentGroupNotifications } from './notification_groups';
import { updateNotifications } from './notifications';
import { updateStatus } from './statuses';
import {
  updateTimeline,
  deleteFromTimelines,
  expandHomeTimeline,
  connectTimeline,
  disconnectTimeline,
  fillHomeTimelineGaps,
  fillPublicTimelineGaps,
  fillCommunityTimelineGaps,
  fillListTimelineGaps,
} from './timelines';

/**
 * An entity payload as the streaming contract (`@tstodon/api`) types it,
 * decoded from the JSON string it arrives as.
 */
const decode = <E extends ApiStreamingEventName>(
  _event: E,
  payload: string,
): ApiStreamingPayloadJSON<E> => JSON.parse(payload);

const isRenderedNotification = (
  notification: ApiNotificationJSON,
): notification is ApiMastodonNotificationJSON =>
  isMastodonNotificationType(notification.type);

const randomUpTo = (max: number) =>
  Math.floor(Math.random() * Math.floor(max));

type FallbackFunction = (dispatch: AppDispatch, getState: GetState) => Promise<void>;

interface TimelineStreamOptions {
  fallback?: FallbackFunction;
  fillGaps?: () => (dispatch: AppDispatch, getState: GetState) => Promise<void>;
  accept?: (status: ApiStatusJSON) => boolean;
}

export const connectTimelineStream = (
  timelineId: string,
  channelName: string,
  params: StreamParams = {},
  options: TimelineStreamOptions = {},
) => {
  const { messages } = getLocale();

  // Public streams are currently not returning personalized quote policies
  const bogusQuotePolicy = channelName.startsWith('public') || channelName.startsWith('hashtag');

  return connectStream(channelName, params, (dispatch, getState) => {
    const locale: unknown = getState().meta.get('locale');

    let pollingId: ReturnType<typeof setTimeout> | null = null;

    const useFallback = async (fallback: FallbackFunction) => {
      await fallback(dispatch, getState);
      // eslint-disable-next-line react-hooks/rules-of-hooks -- this is not a react hook
      pollingId = setTimeout(() => useFallback(fallback), 20000 + randomUpTo(20000));
    };

    return {
      onConnect() {
        dispatch(connectTimeline(timelineId));

        if (pollingId) {
          clearTimeout(pollingId); pollingId = null;
        }

        if (options.fillGaps) {
          void dispatch(options.fillGaps());
        }
      },

      onDisconnect() {
        dispatch(disconnectTimeline({ timeline: timelineId }));

        const { fallback } = options;

        if (fallback) {
          pollingId = setTimeout(() => useFallback(fallback), randomUpTo(40000));
        }
      },

      onReceive(data) {
        switch (data.event) {
        case 'update':
          dispatch(updateTimeline(timelineId, decode('update', data.payload), { accept: options.accept, bogusQuotePolicy }));
          break;
        case 'status.update':
          dispatch(updateStatus(decode('status.update', data.payload), { bogusQuotePolicy }));
          break;
        case 'delete':
          dispatch(deleteFromTimelines(data.payload));
          break;
        case 'notification': {
          const notificationJSON = decode('notification', data.payload);
          // tstodon's `move` notification is not one this UI renders (its
          // REST requests leave it out by type), so the stream's is dropped.
          if (!isRenderedNotification(notificationJSON)) break;
          dispatch(updateNotifications(notificationJSON, messages, typeof locale === 'string' ? locale : undefined));
          // TODO: remove this once the groups feature replaces the previous one
          dispatch(processNewNotificationForGroups(notificationJSON));
          break;
        }
        case 'notifications_merged': {
          void dispatch(refreshStaleNotificationGroups());
          break;
        }
        case 'conversation':
          dispatch(updateConversations(decode('conversation', data.payload)));
          break;
        case 'announcement':
          dispatch(updateAnnouncements(decode('announcement', data.payload)));
          break;
        case 'announcement.reaction':
          dispatch(updateAnnouncementsReaction(decode('announcement.reaction', data.payload)));
          break;
        case 'announcement.delete':
          dispatch(deleteAnnouncement(data.payload));
          break;
        }
      },
    };
  });
};

async function refreshHomeTimelineAndNotification(dispatch: AppDispatch) {
  await dispatch(expandHomeTimeline({ maxId: undefined }));

  // TODO: polling for merged notifications
  try {
    await dispatch(pollRecentGroupNotifications());
  } catch {
    // TODO
  }

  dispatch(fetchAnnouncements());
}

export const connectUserStream = () =>
  connectTimelineStream('home', 'user', {}, {
    fallback: refreshHomeTimelineAndNotification,
    fillGaps: fillHomeTimelineGaps,
  });

export const connectCommunityStream = ({ onlyMedia }: { onlyMedia?: boolean } = {}) =>
  connectTimelineStream(`community${onlyMedia ? ':media' : ''}`, `public:local${onlyMedia ? ':media' : ''}`, {}, {
    fillGaps: () => (fillCommunityTimelineGaps({ onlyMedia })),
  });

export const connectPublicStream = ({ onlyMedia, onlyRemote }: { onlyMedia?: boolean, onlyRemote?: boolean } = {}) =>
  connectTimelineStream(`public${onlyRemote ? ':remote' : ''}${onlyMedia ? ':media' : ''}`, `public${onlyRemote ? ':remote' : ''}${onlyMedia ? ':media' : ''}`, {}, {
    fillGaps: () => fillPublicTimelineGaps({ onlyMedia, onlyRemote }),
  });

export const connectHashtagStream = (columnId: string, tagName: string, onlyLocal: boolean, accept: (status: ApiStatusJSON) => boolean) =>
  connectTimelineStream(`hashtag:${columnId}${onlyLocal ? ':local' : ''}`, `hashtag${onlyLocal ? ':local' : ''}`, { tag: tagName }, { accept });

export const connectDirectStream = () =>
  connectTimelineStream('direct', 'direct');

export const connectListStream = (listId: string) =>
  connectTimelineStream(`list:${listId}`, 'list', { list: listId }, {
    fillGaps: () => fillListTimelineGaps(listId),
  });
