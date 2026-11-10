// @ts-check

import { isMastodonNotificationType } from '@tstodon/api/values';

import { getLocale } from '../locales';
import { connectStream } from '../stream';

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
 * @template {import('@tstodon/api').ApiStreamingEventName} E
 * @param {E} _event
 * @param {string} payload
 * @returns {import('@tstodon/api').ApiStreamingPayloadJSON<E>}
 */
const decode = (_event, payload) => JSON.parse(payload);

/**
 * @param {import('@tstodon/api').ApiNotificationJSON} notification
 * @returns {notification is import('@tstodon/api').ApiMastodonNotificationJSON}
 */
const isRenderedNotification = notification =>
  isMastodonNotificationType(notification.type);

/**
 * @param {number} max
 * @returns {number}
 */
const randomUpTo = max =>
  Math.floor(Math.random() * Math.floor(max));

/**
 * @typedef {import('mastodon/store').AppDispatch} Dispatch
 * @typedef {import('mastodon/store').GetState} GetState
 * @typedef {import('redux').UnknownAction} UnknownAction
 * @typedef {(dispatch: Dispatch, getState: GetState) => Promise<void>} FallbackFunction
 */

/**
 * @param {string} timelineId
 * @param {string} channelName
 * @param {Object.<string, string>} params
 * @param {Object} options
 * @param {FallbackFunction} [options.fallback]
 * @param {() => UnknownAction} [options.fillGaps]
 * @param {(status: object) => boolean} [options.accept]
 * @returns {() => void}
 */
export const connectTimelineStream = (timelineId, channelName, params = {}, options = {}) => {
  const { messages } = getLocale();

  // Public streams are currently not returning personalized quote policies
  const bogusQuotePolicy = channelName.startsWith('public') || channelName.startsWith('hashtag');

  return connectStream(channelName, params, (dispatch, getState) => {
    // @ts-ignore
    const locale = getState().getIn(['meta', 'locale']);

    // @ts-expect-error
    let pollingId;

    /**
     * @param {FallbackFunction} fallback
     */

    const useFallback = async fallback => {
      await fallback(dispatch, getState);
      // eslint-disable-next-line react-hooks/rules-of-hooks -- this is not a react hook
      pollingId = setTimeout(() => useFallback(fallback), 20000 + randomUpTo(20000));
    };

    return {
      onConnect() {
        dispatch(connectTimeline(timelineId));

        // @ts-expect-error
        if (pollingId) {
          // @ts-ignore
          clearTimeout(pollingId); pollingId = null;
        }

        if (options.fillGaps) {
          dispatch(options.fillGaps());
        }
      },

      onDisconnect() {
        dispatch(disconnectTimeline({ timeline: timelineId }));

        if (options.fallback) {
          // @ts-expect-error
          pollingId = setTimeout(() => useFallback(options.fallback), randomUpTo(40000));
        }
      },

      onReceive(data) {
        switch (data.event) {
        case 'update':
          // @ts-expect-error
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
          dispatch(updateNotifications(notificationJSON, messages, locale));
          // TODO: remove this once the groups feature replaces the previous one
          dispatch(processNewNotificationForGroups(notificationJSON));
          break;
        }
        case 'notifications_merged': {
          dispatch(refreshStaleNotificationGroups());
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

/**
 * @param {Dispatch} dispatch
 */
async function refreshHomeTimelineAndNotification(dispatch) {
  await dispatch(expandHomeTimeline({ maxId: undefined }));

  // TODO: polling for merged notifications
  try {
    await dispatch(pollRecentGroupNotifications());
  } catch {
    // TODO
  }

  await dispatch(fetchAnnouncements());
}

/**
 * @returns {() => void}
 */
export const connectUserStream = () =>
  connectTimelineStream('home', 'user', {}, {
    fallback: refreshHomeTimelineAndNotification,
    // @ts-expect-error
    fillGaps: fillHomeTimelineGaps
  });

/**
 * @param {Object} options
 * @param {boolean} [options.onlyMedia]
 * @returns {() => void}
 */
export const connectCommunityStream = ({ onlyMedia } = {}) =>
  connectTimelineStream(`community${onlyMedia ? ':media' : ''}`, `public:local${onlyMedia ? ':media' : ''}`, {}, {
    // @ts-expect-error
    fillGaps: () => (fillCommunityTimelineGaps({ onlyMedia }))
  });

/**
 * @param {Object} options
 * @param {boolean} [options.onlyMedia]
 * @param {boolean} [options.onlyRemote]
 * @returns {() => void}
 */
export const connectPublicStream = ({ onlyMedia, onlyRemote } = {}) =>
  connectTimelineStream(`public${onlyRemote ? ':remote' : ''}${onlyMedia ? ':media' : ''}`, `public${onlyRemote ? ':remote' : ''}${onlyMedia ? ':media' : ''}`, {}, {
    // @ts-expect-error
    fillGaps: () => fillPublicTimelineGaps({ onlyMedia, onlyRemote })
  });

/**
 * @param {string} columnId
 * @param {string} tagName
 * @param {boolean} onlyLocal
 * @param {(status: object) => boolean} accept
 * @returns {() => void}
 */
export const connectHashtagStream = (columnId, tagName, onlyLocal, accept) =>
  connectTimelineStream(`hashtag:${columnId}${onlyLocal ? ':local' : ''}`, `hashtag${onlyLocal ? ':local' : ''}`, { tag: tagName }, { accept });

/**
 * @returns {() => void}
 */
export const connectDirectStream = () =>
  connectTimelineStream('direct', 'direct');

/**
 * @param {string} listId
 * @returns {() => void}
 */
export const connectListStream = listId =>
  connectTimelineStream(`list:${listId}`, 'list', { list: listId }, {
    // @ts-expect-error
    fillGaps: () => fillListTimelineGaps(listId)
  });
