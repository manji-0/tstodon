import { List as ImmutableList, Map as ImmutableMap } from 'immutable';

import type { ApiAnnouncementReactionEventJSON } from '@tstodon/api';
import {
  apiAddAnnouncementReaction,
  apiDismissAnnouncement,
  apiGetAnnouncements,
  apiRemoveAnnouncementReaction,
} from 'mastodon/api/announcements';
import type { ApiAnnouncementJSON } from 'mastodon/api_types/announcements';
import type { AppDispatch, GetState } from 'mastodon/store';

import { normalizeAnnouncement } from './importer/normalizer';

export const ANNOUNCEMENTS_FETCH_REQUEST = 'ANNOUNCEMENTS_FETCH_REQUEST';
export const ANNOUNCEMENTS_FETCH_SUCCESS = 'ANNOUNCEMENTS_FETCH_SUCCESS';
export const ANNOUNCEMENTS_FETCH_FAIL    = 'ANNOUNCEMENTS_FETCH_FAIL';
export const ANNOUNCEMENTS_UPDATE        = 'ANNOUNCEMENTS_UPDATE';
export const ANNOUNCEMENTS_DELETE        = 'ANNOUNCEMENTS_DELETE';

export const ANNOUNCEMENTS_DISMISS_REQUEST = 'ANNOUNCEMENTS_DISMISS_REQUEST';
export const ANNOUNCEMENTS_DISMISS_SUCCESS = 'ANNOUNCEMENTS_DISMISS_SUCCESS';
export const ANNOUNCEMENTS_DISMISS_FAIL    = 'ANNOUNCEMENTS_DISMISS_FAIL';

export const ANNOUNCEMENTS_REACTION_ADD_REQUEST = 'ANNOUNCEMENTS_REACTION_ADD_REQUEST';
export const ANNOUNCEMENTS_REACTION_ADD_SUCCESS = 'ANNOUNCEMENTS_REACTION_ADD_SUCCESS';
export const ANNOUNCEMENTS_REACTION_ADD_FAIL    = 'ANNOUNCEMENTS_REACTION_ADD_FAIL';

export const ANNOUNCEMENTS_REACTION_REMOVE_REQUEST = 'ANNOUNCEMENTS_REACTION_REMOVE_REQUEST';
export const ANNOUNCEMENTS_REACTION_REMOVE_SUCCESS = 'ANNOUNCEMENTS_REACTION_REMOVE_SUCCESS';
export const ANNOUNCEMENTS_REACTION_REMOVE_FAIL    = 'ANNOUNCEMENTS_REACTION_REMOVE_FAIL';

export const ANNOUNCEMENTS_REACTION_UPDATE = 'ANNOUNCEMENTS_REACTION_UPDATE';

export const ANNOUNCEMENTS_TOGGLE_SHOW = 'ANNOUNCEMENTS_TOGGLE_SHOW';

const noOp = () => {};

/** An announcement as the reducer takes it: with its content as `contentHtml` too. */
type NormalizedAnnouncement = ReturnType<typeof normalizeAnnouncement>;

export const fetchAnnouncements = (done = noOp) => (dispatch: AppDispatch) => {
  dispatch(fetchAnnouncementsRequest());

  apiGetAnnouncements().then(announcements => {
    dispatch(fetchAnnouncementsSuccess(announcements.map(x => normalizeAnnouncement(x))));
  }).catch((error: unknown) => {
    dispatch(fetchAnnouncementsFail(error));
  }).finally(() => {
    done();
  });
};

export const fetchAnnouncementsRequest = () => ({
  type: ANNOUNCEMENTS_FETCH_REQUEST,
  skipLoading: true,
});

export const fetchAnnouncementsSuccess = (announcements: NormalizedAnnouncement[]) => ({
  type: ANNOUNCEMENTS_FETCH_SUCCESS,
  announcements,
  skipLoading: true,
});

export const fetchAnnouncementsFail= (error: unknown) => ({
  type: ANNOUNCEMENTS_FETCH_FAIL,
  error,
  skipLoading: true,
  skipAlert: true,
});

export const updateAnnouncements = (announcement: ApiAnnouncementJSON) => ({
  type: ANNOUNCEMENTS_UPDATE,
  announcement: normalizeAnnouncement(announcement),
});

export const dismissAnnouncement = (announcementId: string) => (dispatch: AppDispatch) => {
  dispatch(dismissAnnouncementRequest(announcementId));

  apiDismissAnnouncement(announcementId).then(() => {
    dispatch(dismissAnnouncementSuccess(announcementId));
  }).catch((error: unknown) => {
    dispatch(dismissAnnouncementFail(announcementId, error));
  });
};

export const dismissAnnouncementRequest = (announcementId: string) => ({
  type: ANNOUNCEMENTS_DISMISS_REQUEST,
  id: announcementId,
});

export const dismissAnnouncementSuccess = (announcementId: string) => ({
  type: ANNOUNCEMENTS_DISMISS_SUCCESS,
  id: announcementId,
});

export const dismissAnnouncementFail = (announcementId: string, error: unknown) => ({
  type: ANNOUNCEMENTS_DISMISS_FAIL,
  id: announcementId,
  error,
});

/** The entries of an Immutable list in the (untyped) announcements state that are maps. */
const immutableMaps = (list: unknown): ImmutableMap<string, unknown>[] =>
  ImmutableList.isList(list)
    ? list.toArray().filter((item): item is ImmutableMap<string, unknown> => ImmutableMap.isMap(item))
    : [];

export const addReaction = (announcementId: string, name: string) => (dispatch: AppDispatch, getState: GetState) => {
  const announcement = immutableMaps(getState().announcements.get('items')).find(x => x.get('id') === announcementId);

  let alreadyAdded = false;

  if (announcement) {
    const reaction = immutableMaps(announcement.get('reactions')).find(x => x.get('name') === name);
    if (reaction && reaction.get('me')) {
      alreadyAdded = true;
    }
  }

  if (!alreadyAdded) {
    dispatch(addReactionRequest(announcementId, name));
  }

  apiAddAnnouncementReaction(announcementId, name).then(() => {
    dispatch(addReactionSuccess(announcementId, name));
  }).catch((err: unknown) => {
    if (!alreadyAdded) {
      dispatch(addReactionFail(announcementId, name, err));
    }
  });
};

export const addReactionRequest = (announcementId: string, name: string) => ({
  type: ANNOUNCEMENTS_REACTION_ADD_REQUEST,
  id: announcementId,
  name,
  skipLoading: true,
});

export const addReactionSuccess = (announcementId: string, name: string) => ({
  type: ANNOUNCEMENTS_REACTION_ADD_SUCCESS,
  id: announcementId,
  name,
  skipLoading: true,
});

export const addReactionFail = (announcementId: string, name: string, error: unknown) => ({
  type: ANNOUNCEMENTS_REACTION_ADD_FAIL,
  id: announcementId,
  name,
  error,
  skipLoading: true,
});

export const removeReaction = (announcementId: string, name: string) => (dispatch: AppDispatch) => {
  dispatch(removeReactionRequest(announcementId, name));

  apiRemoveAnnouncementReaction(announcementId, name).then(() => {
    dispatch(removeReactionSuccess(announcementId, name));
  }).catch((err: unknown) => {
    dispatch(removeReactionFail(announcementId, name, err));
  });
};

export const removeReactionRequest = (announcementId: string, name: string) => ({
  type: ANNOUNCEMENTS_REACTION_REMOVE_REQUEST,
  id: announcementId,
  name,
  skipLoading: true,
});

export const removeReactionSuccess = (announcementId: string, name: string) => ({
  type: ANNOUNCEMENTS_REACTION_REMOVE_SUCCESS,
  id: announcementId,
  name,
  skipLoading: true,
});

export const removeReactionFail = (announcementId: string, name: string, error: unknown) => ({
  type: ANNOUNCEMENTS_REACTION_REMOVE_FAIL,
  id: announcementId,
  name,
  error,
  skipLoading: true,
});

export const updateReaction = (reaction: ApiAnnouncementReactionEventJSON) => ({
  type: ANNOUNCEMENTS_REACTION_UPDATE,
  reaction,
});

export const toggleShowAnnouncements = () => ({
  type: ANNOUNCEMENTS_TOGGLE_SHOW,
});

export const deleteAnnouncement = (id: string) => ({
  type: ANNOUNCEMENTS_DELETE,
  id,
});
