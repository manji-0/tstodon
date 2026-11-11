import type { ApiAnnouncementJSON } from '@tstodon/api';

import {
  addReactionFail,
  addReactionRequest,
  deleteAnnouncement,
  dismissAnnouncementSuccess,
  fetchAnnouncementsFail,
  fetchAnnouncementsRequest,
  fetchAnnouncementsSuccess,
  removeReactionRequest,
  toggleShowAnnouncements,
  updateAnnouncements,
  updateReaction,
} from '../actions/announcements';
import { normalizeAnnouncement } from '../actions/importer/normalizer';
import { immutableToJS } from '../utils/immutable_map_of';

import announcements from './announcements';

const announcement = (
  id: string,
  data: Partial<ApiAnnouncementJSON> = {},
): ApiAnnouncementJSON => ({
  id,
  content: `<p>${id}</p>`,
  starts_at: null,
  ends_at: null,
  all_day: false,
  published_at: `2025-01-0${id}T00:00:00.000Z`,
  updated_at: null,
  read: false,
  mentions: [],
  statuses: [],
  tags: [],
  emojis: [],
  reactions: [],
  ...data,
});

const loaded = (...items: ApiAnnouncementJSON[]) =>
  announcements(
    undefined,
    fetchAnnouncementsSuccess(items.map((item) => normalizeAnnouncement(item))),
  );

const reactions = (state: ReturnType<typeof announcements>, id: string) => {
  const item = state.get('items').find((x) => x.get('id') === id);

  return item ? immutableToJS(item.get('reactions')) : undefined;
};

describe('announcements reducer', () => {
  it('starts empty and hidden', () => {
    expect(announcements(undefined, { type: 'INIT' }).toJS()).toEqual({
      items: [],
      isLoading: false,
      show: false,
    });
  });

  it('loads the announcements', () => {
    let state = announcements(undefined, fetchAnnouncementsRequest());
    expect(state.get('isLoading')).toBe(true);

    state = announcements(
      state,
      fetchAnnouncementsSuccess([normalizeAnnouncement(announcement('1'))]),
    );
    expect(state.get('isLoading')).toBe(false);
    expect(immutableToJS(state.get('items'))).toEqual([
      { ...announcement('1'), contentHtml: '<p>1</p>' },
    ]);

    expect(
      announcements(state, fetchAnnouncementsFail(new Error())).get(
        'isLoading',
      ),
    ).toBe(false);
  });

  it('toggles whether they are shown', () => {
    const state = announcements(undefined, toggleShowAnnouncements());

    expect(state.get('show')).toBe(true);
    expect(announcements(state, toggleShowAnnouncements()).get('show')).toBe(
      false,
    );
  });

  it('adds a streamed announcement in order', () => {
    let state = loaded(announcement('1'), announcement('3'));
    state = announcements(state, updateAnnouncements(announcement('2')));

    expect(
      state
        .get('items')
        .map((item) => item.get('id'))
        .toArray(),
    ).toEqual(['1', '2', '3']);
  });

  it('merges a streamed announcement, keeping the viewer’s reactions', () => {
    const tags = [{ name: 'news', url: 'https://example.com/tags/news' }];
    let state = loaded(
      announcement('1', {
        tags,
        reactions: [{ name: '👍', count: 1, me: true }],
      }),
    );
    state = announcements(
      state,
      updateAnnouncements(
        announcement('1', {
          content: '<p>edited</p>',
          tags,
          reactions: [
            { name: '👍', count: 2 },
            { name: '🎉', count: 1 },
          ],
        }),
      ),
    );

    expect(state.get('items').size).toBe(1);
    expect(state.get('items').first()?.get('content')).toBe('<p>edited</p>');
    // Upstream's deep merge appended the streamed lists to the old ones.
    expect(state.get('items').first()?.get('tags').size).toBe(1);
    expect(reactions(state, '1')).toEqual([
      { name: '👍', count: 2, me: true },
      { name: '🎉', count: 1 },
    ]);
  });

  it('adds, removes and counts reactions', () => {
    let state = loaded(announcement('1'));

    state = announcements(state, addReactionRequest('1', '👍'));
    expect(reactions(state, '1')).toEqual([{ name: '👍', count: 1, me: true }]);

    state = announcements(state, addReactionFail('1', '👍', new Error()));
    expect(reactions(state, '1')).toEqual([
      { name: '👍', count: 0, me: false },
    ]);

    state = announcements(
      state,
      updateReaction({ announcement_id: '1', name: '👍', count: 5 }),
    );
    state = announcements(state, removeReactionRequest('1', '👍'));
    expect(reactions(state, '1')).toEqual([
      { name: '👍', count: 4, me: false },
    ]);
  });

  it('marks a dismissed announcement as read', () => {
    const state = announcements(
      loaded(announcement('1')),
      dismissAnnouncementSuccess('1'),
    );

    expect(state.get('items').first()?.get('read')).toBe(true);
  });

  it('adds nothing for a dismissed announcement it does not have', () => {
    const state = loaded(announcement('1'));

    expect(announcements(state, dismissAnnouncementSuccess('2'))).toBe(state);
  });

  it('deletes an announcement', () => {
    const state = announcements(
      loaded(announcement('1'), announcement('2')),
      deleteAnnouncement('1'),
    );

    expect(
      state
        .get('items')
        .map((item) => item.get('id'))
        .toArray(),
    ).toEqual(['2']);
  });
});
