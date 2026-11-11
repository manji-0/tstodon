import { createReducer } from '@reduxjs/toolkit';
import { List as ImmutableList } from 'immutable';

import type { ApiAnnouncementReactionEventJSON } from '@tstodon/api';
import type { ApiAnnouncementReactionJSON } from 'mastodon/api_types/announcements';

import {
  ANNOUNCEMENTS_DELETE,
  ANNOUNCEMENTS_DISMISS_SUCCESS,
  ANNOUNCEMENTS_FETCH_FAIL,
  ANNOUNCEMENTS_FETCH_REQUEST,
  ANNOUNCEMENTS_FETCH_SUCCESS,
  ANNOUNCEMENTS_REACTION_ADD_FAIL,
  ANNOUNCEMENTS_REACTION_ADD_REQUEST,
  ANNOUNCEMENTS_REACTION_REMOVE_FAIL,
  ANNOUNCEMENTS_REACTION_REMOVE_REQUEST,
  ANNOUNCEMENTS_REACTION_UPDATE,
  ANNOUNCEMENTS_TOGGLE_SHOW,
  ANNOUNCEMENTS_UPDATE,
} from '../actions/announcements';
import type {
  addReactionFail,
  addReactionRequest,
  deleteAnnouncement,
  dismissAnnouncementSuccess,
  fetchAnnouncementsSuccess,
  NormalizedAnnouncement,
  removeReactionFail,
  removeReactionRequest,
  updateAnnouncements,
  updateReaction as updateReactionAction,
} from '../actions/announcements';
import { immutableFromJS, immutableMapOf } from '../utils/immutable_map_of';
import type { ImmutableMapOf, ImmutableOf } from '../utils/immutable_map_of';

/** An announcement (`ApiAnnouncementJSON` with `contentHtml`) as the store keeps it. */
export type Announcement = ImmutableOf<NormalizedAnnouncement>;
type Reaction = ImmutableOf<ApiAnnouncementReactionJSON>;

export interface AnnouncementsShape {
  /** Sorted by `starts_at`, or `published_at` when it has none. */
  items: ImmutableList<Announcement>;
  isLoading: boolean;
  show: boolean;
}

type State = ImmutableMapOf<AnnouncementsShape>;

const initialState: State = immutableMapOf<AnnouncementsShape>({
  items: ImmutableList(),
  isLoading: false,
  show: false,
});

const updateReaction = (
  state: State,
  id: string,
  name: string,
  updater: (reaction: Reaction) => Reaction,
) =>
  state.update('items', (list) =>
    list.map((announcement) => {
      if (announcement.get('id') === id) {
        return announcement.update('reactions', (reactions) => {
          const idx = reactions.findIndex(
            (reaction) => reaction.get('name') === name,
          );

          if (idx > -1) {
            return reactions.update(
              idx,
              (reaction) => reaction && updater(reaction),
            );
          }

          return reactions.push(
            updater(
              immutableFromJS<ApiAnnouncementReactionJSON>({ name, count: 0 }),
            ),
          );
        });
      }

      return announcement;
    }),
  );

const updateReactionCount = (
  state: State,
  reaction: ApiAnnouncementReactionEventJSON,
) =>
  updateReaction(state, reaction.announcement_id, reaction.name, (x) =>
    x.set('count', reaction.count),
  );

const addReaction = (state: State, id: string, name: string) =>
  updateReaction(state, id, name, (x) =>
    x.set('me', true).update('count', (y) => y + 1),
  );

const removeReaction = (state: State, id: string, name: string) =>
  updateReaction(state, id, name, (x) =>
    x.set('me', false).update('count', (y) => y - 1),
  );

const sortAnnouncements = (list: ImmutableList<Announcement>) =>
  list.sortBy((x) => x.get('starts_at') || x.get('published_at'));

/**
 * Announcements from the streaming API do not contain personalized data about
 * which reactions have been selected by the given user, and that is
 * information we want to preserve. Upstream deep-merged the announcement for
 * that, but Immutable 4's `mergeDeep` concatenates lists: each update added
 * its reactions, mentions, tags and emojis again after the old ones.
 */
const mergeAnnouncement = (old: Announcement, announcement: Announcement) => {
  const oldReactions = old.get('reactions');

  return old.merge(announcement).set(
    'reactions',
    announcement.get('reactions').map((reaction) => {
      const me = oldReactions
        .find((x) => x.get('name') === reaction.get('name'))
        ?.get('me');

      return me === undefined || reaction.has('me')
        ? reaction
        : reaction.set('me', me);
    }),
  );
};

const updateAnnouncement = (state: State, announcement: Announcement) => {
  const idx = state
    .get('items')
    .findIndex((x) => x.get('id') === announcement.get('id'));

  if (idx > -1) {
    return state.update('items', (list) =>
      sortAnnouncements(
        list.update(idx, (x) => x && mergeAnnouncement(x, announcement)),
      ),
    );
  }

  return state.update('items', (list) =>
    sortAnnouncements(list.unshift(announcement)),
  );
};

/**
 * Upstream merged `{ id, read: true }` like a streamed announcement, which
 * added that bare object as an announcement when the id was not (or no
 * longer) in the list.
 */
const markAnnouncementRead = (state: State, id: string) => {
  const idx = state.get('items').findIndex((x) => x.get('id') === id);

  if (idx > -1) {
    return state.update('items', (list) =>
      sortAnnouncements(list.update(idx, (x) => x && x.set('read', true))),
    );
  }

  return state;
};

export default createReducer(initialState, (builder) => {
  builder
    .addCase(ANNOUNCEMENTS_TOGGLE_SHOW, (state) =>
      state.withMutations((map) => {
        map.set('show', !map.get('show'));
      }),
    )
    .addCase(ANNOUNCEMENTS_FETCH_REQUEST, (state) =>
      state.set('isLoading', true),
    )
    .addCase(
      ANNOUNCEMENTS_FETCH_SUCCESS,
      (state, action: ReturnType<typeof fetchAnnouncementsSuccess>) =>
        state.withMutations((map) => {
          const items = immutableFromJS(action.announcements);

          map.set('items', items);
          map.set('isLoading', false);
        }),
    )
    .addCase(ANNOUNCEMENTS_FETCH_FAIL, (state) =>
      state.set('isLoading', false),
    )
    .addCase(
      ANNOUNCEMENTS_UPDATE,
      (state, action: ReturnType<typeof updateAnnouncements>) =>
        updateAnnouncement(state, immutableFromJS(action.announcement)),
    )
    .addCase(
      ANNOUNCEMENTS_REACTION_UPDATE,
      (state, action: ReturnType<typeof updateReactionAction>) =>
        updateReactionCount(state, action.reaction),
    )
    .addCase(
      ANNOUNCEMENTS_REACTION_ADD_REQUEST,
      (state, action: ReturnType<typeof addReactionRequest>) =>
        addReaction(state, action.id, action.name),
    )
    .addCase(
      ANNOUNCEMENTS_REACTION_REMOVE_FAIL,
      (state, action: ReturnType<typeof removeReactionFail>) =>
        addReaction(state, action.id, action.name),
    )
    .addCase(
      ANNOUNCEMENTS_REACTION_REMOVE_REQUEST,
      (state, action: ReturnType<typeof removeReactionRequest>) =>
        removeReaction(state, action.id, action.name),
    )
    .addCase(
      ANNOUNCEMENTS_REACTION_ADD_FAIL,
      (state, action: ReturnType<typeof addReactionFail>) =>
        removeReaction(state, action.id, action.name),
    )
    .addCase(
      ANNOUNCEMENTS_DISMISS_SUCCESS,
      (state, action: ReturnType<typeof dismissAnnouncementSuccess>) =>
        markAnnouncementRead(state, action.id),
    )
    .addCase(
      ANNOUNCEMENTS_DELETE,
      (state, action: ReturnType<typeof deleteAnnouncement>) =>
        state.update('items', (list) => {
          const idx = list.findIndex((x) => x.get('id') === action.id);

          if (idx > -1) {
            return list.delete(idx);
          }

          return list;
        }),
    );
});
