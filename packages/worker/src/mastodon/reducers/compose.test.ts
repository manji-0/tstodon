import { fromJS, List as ImmutableList, Map as ImmutableMap } from 'immutable';

import type { ApiMediaAttachmentJSON } from 'mastodon/api_types/media_attachments';
import type { ApiHashtagJSON } from 'mastodon/api_types/tags';
import type { Status } from 'mastodon/models/status';

import {
  COMPOSE_CHANGE,
  COMPOSE_CHANGE_MEDIA_ORDER,
  COMPOSE_COMPOSING_CHANGE,
  COMPOSE_DIRECT,
  COMPOSE_EMOJI_INSERT,
  COMPOSE_FOCUS,
  COMPOSE_LANGUAGE_CHANGE,
  COMPOSE_MENTION,
  COMPOSE_MOUNT,
  COMPOSE_POLL_ADD,
  COMPOSE_POLL_OPTION_CHANGE,
  COMPOSE_POLL_REMOVE,
  COMPOSE_POLL_SETTINGS_CHANGE,
  COMPOSE_REPLY,
  COMPOSE_REPLY_CANCEL,
  COMPOSE_RESET,
  COMPOSE_SENSITIVITY_CHANGE,
  COMPOSE_SET_STATUS,
  COMPOSE_SPOILERNESS_CHANGE,
  COMPOSE_SPOILER_TEXT_CHANGE,
  COMPOSE_SUBMIT_FAIL,
  COMPOSE_SUBMIT_REQUEST,
  COMPOSE_SUBMIT_SUCCESS,
  COMPOSE_SUGGESTIONS_CLEAR,
  COMPOSE_SUGGESTIONS_READY,
  COMPOSE_SUGGESTION_IGNORE,
  COMPOSE_SUGGESTION_SELECT,
  COMPOSE_SUGGESTION_TAGS_UPDATE,
  COMPOSE_TAG_HISTORY_UPDATE,
  COMPOSE_UNMOUNT,
  COMPOSE_UPLOAD_FAIL,
  COMPOSE_UPLOAD_PROCESSING,
  COMPOSE_UPLOAD_PROGRESS,
  COMPOSE_UPLOAD_REQUEST,
  COMPOSE_UPLOAD_SUCCESS,
  COMPOSE_UPLOAD_UNDO,
  THUMBNAIL_UPLOAD_FAIL,
  THUMBNAIL_UPLOAD_PROGRESS,
  THUMBNAIL_UPLOAD_REQUEST,
  THUMBNAIL_UPLOAD_SUCCESS,
} from '../actions/compose';
import {
  cancelPasteLinkCompose,
  changeComposeVisibility,
  changeUploadCompose,
  pasteLinkCompose,
  quoteCompose,
  quoteComposeCancel,
  setComposeQuotePolicy,
  setDragUploadEnabled,
} from '../actions/compose_typed';
import { REDRAFT } from '../actions/statuses';
import { STORE_HYDRATE } from '../actions/store';
import { timelineDelete } from '../actions/timelines_typed';

import { composeReducer } from './compose';

type ComposeState = ReturnType<typeof composeReducer>;

const init = (): ComposeState => composeReducer(undefined, { type: '@@INIT' });

const reduce = (
  state: ComposeState,
  ...actions: { type: string; [key: string]: unknown }[]
) => actions.reduce((s, action) => composeReducer(s, action), state);

const hydrated = (compose: Record<string, unknown>) =>
  reduce(init(), {
    type: STORE_HYDRATE,
    state: fromJS({ compose }),
  });

const media = (
  id: string,
  type: ApiMediaAttachmentJSON['type'] = 'image',
): ApiMediaAttachmentJSON => ({
  id,
  type,
  url: `https://example.com/${id}`,
  preview_url: `https://example.com/${id}/small`,
  remote_url: null,
  description: null,
  blurhash: null,
  meta: {},
});

const tag = (name: string): ApiHashtagJSON => ({
  id: name,
  name,
  url: `https://example.com/tags/${name}`,
  history: [{ day: '1700000000', accounts: '1', uses: '2' }],
});

const statusOf = (fields: Record<string, unknown>): Status =>
  ImmutableMap<string, unknown>(
    fromJS({
      id: '10',
      account: { id: '1', acct: 'alice' },
      mentions: [{ id: '2', acct: 'bob', url: 'https://example.com/@bob' }],
      visibility: 'public',
      language: 'de',
      spoiler_text: '',
      sensitive: false,
      media_attachments: [],
      in_reply_to_id: null,
      content:
        '<p><a href="https://example.com/@bob" class="mention">@<span>bob</span></a> hello</p>',
      quote_approval: { automatic: ['followers'], manual: [], current_user: 'automatic' },
      ...fields,
    }),
  );

describe('composeReducer', () => {
  test('starts with upstream initial state', () => {
    const state = init();
    const { resetFileKey, ...rest } = state.toJS();

    expect(typeof resetFileKey).toBe('number');
    expect(rest).toEqual({
      mounted: 0,
      sensitive: false,
      spoiler: false,
      spoiler_text: '',
      privacy: null,
      id: null,
      text: '',
      focusDate: null,
      caretPosition: null,
      preselectDate: null,
      in_reply_to: null,
      is_composing: false,
      is_submitting: false,
      is_changing_upload: false,
      is_uploading: false,
      isDragDisabled: false,
      should_redirect_to_compose_page: false,
      progress: 0,
      isUploadingThumbnail: false,
      thumbnailProgress: 0,
      media_attachments: [],
      pending_media_attachments: 0,
      poll: null,
      suggestion_token: null,
      suggestions: [],
      default_privacy: 'public',
      default_sensitive: false,
      default_language: 'en',
      idempotencyKey: null,
      tagHistory: [],
      quoted_status_id: null,
      quote_policy: 'public',
      default_quote_policy: 'public',
      fetching_link: null,
    });
  });

  test('hydrates the posting defaults and clears the form', () => {
    const state = hydrated({
      me: '1',
      default_privacy: 'unlisted',
      default_sensitive: true,
      default_language: 'fr',
      default_quote_policy: 'followers',
    });

    expect(state.get('me')).toBe('1');
    expect(state.get('default_privacy')).toBe('unlisted');
    expect(state.get('privacy')).toBe('unlisted');
    expect(state.get('sensitive')).toBe(true);
    expect(state.get('language')).toBe('fr');
    expect(state.get('quote_policy')).toBe('followers');
    expect(state.get('text')).toBe('');
    expect(state.get('focusDate')).toBe(null);
    expect(typeof state.get('idempotencyKey')).toBe('string');
  });

  test('hydrates a shared text and focuses it', () => {
    const state = hydrated({ text: 'shared' });

    expect(state.get('text')).toBe('shared');
    expect(state.get('focusDate')).toBeInstanceOf(Date);
  });

  test('ignores a hydration without compose', () => {
    const state = init();
    expect(
      composeReducer(state, { type: STORE_HYDRATE, state: fromJS({}) }),
    ).toBe(state);
  });

  test('changes text, spoiler and sensitivity', () => {
    let state = reduce(init(), { type: COMPOSE_CHANGE, text: 'hi' });
    expect(state.get('text')).toBe('hi');

    state = reduce(state, { type: COMPOSE_SPOILER_TEXT_CHANGE, text: 'cw' });
    expect(state.get('spoiler_text')).toBe('');

    state = reduce(
      state,
      { type: COMPOSE_SPOILERNESS_CHANGE },
      { type: COMPOSE_SPOILER_TEXT_CHANGE, text: 'cw' },
    );
    expect(state.get('spoiler')).toBe(true);
    expect(state.get('spoiler_text')).toBe('cw');

    // The spoiler forces sensitivity, so the toggle does nothing.
    state = reduce(state, { type: COMPOSE_SENSITIVITY_CHANGE });
    expect(state.get('sensitive')).toBe(false);

    state = reduce(
      state,
      { type: COMPOSE_SPOILERNESS_CHANGE },
      { type: COMPOSE_SENSITIVITY_CHANGE },
    );
    expect(state.get('spoiler')).toBe(false);
    expect(state.get('sensitive')).toBe(true);

    state = reduce(
      state,
      { type: COMPOSE_COMPOSING_CHANGE, value: true },
      { type: COMPOSE_LANGUAGE_CHANGE, language: 'ja' },
    );
    expect(state.get('is_composing')).toBe(true);
    expect(state.get('language')).toBe('ja');
  });

  test('mounts and asks for a redirect when unmounted with a draft', () => {
    let state = reduce(
      init(),
      { type: COMPOSE_MOUNT },
      { type: COMPOSE_COMPOSING_CHANGE, value: true },
      { type: COMPOSE_CHANGE, text: 'draft' },
    );
    expect(state.get('mounted')).toBe(1);

    state = reduce(state, { type: COMPOSE_UNMOUNT });
    expect(state.get('mounted')).toBe(0);
    expect(state.get('is_composing')).toBe(false);
    expect(state.get('should_redirect_to_compose_page')).toBe(true);

    state = reduce(state, { type: COMPOSE_MOUNT }, { type: COMPOSE_UNMOUNT });
    expect(state.get('should_redirect_to_compose_page')).toBe(false);
    expect(reduce(state, { type: COMPOSE_UNMOUNT }).get('mounted')).toBe(0);
  });

  test('replies to a status', () => {
    const state = reduce(
      hydrated({ default_privacy: 'unlisted', default_language: 'en' }),
      { type: COMPOSE_UPLOAD_REQUEST },
      { type: COMPOSE_UPLOAD_SUCCESS, media: media('m1'), file: null },
      {
        type: COMPOSE_REPLY,
        status: statusOf({ visibility: 'private', spoiler_text: 'cw' }),
      },
    );

    expect(state.get('in_reply_to')).toBe('10');
    expect(state.get('text')).toBe('@alice @bob ');
    expect(state.get('privacy')).toBe('private');
    expect(state.get('language')).toBe('de');
    expect(state.get('spoiler')).toBe(true);
    expect(state.get('spoiler_text')).toBe('cw');
    expect(state.get('sensitive')).toBe(true);
    expect(state.get('media_attachments').size).toBe(1);
    expect(state.get('focusDate')).toBeInstanceOf(Date);
    expect(state.get('preselectDate')).toBeInstanceOf(Date);

    const cancelled = reduce(state, { type: COMPOSE_REPLY_CANCEL });
    expect(cancelled.get('in_reply_to')).toBe(null);
    expect(cancelled.get('text')).toBe('');
    expect(cancelled.get('privacy')).toBe('unlisted');
    expect(cancelled.get('media_attachments').size).toBe(0);
  });

  test('replies with the more private visibility and default language', () => {
    const state = reduce(hydrated({ default_privacy: 'private' }), {
      type: COMPOSE_REPLY,
      status: statusOf({
        visibility: 'public',
        language: null,
        translation: {},
      }),
    });

    expect(state.get('privacy')).toBe('private');
    expect(state.get('language')).toBe('en');
    expect(state.get('spoiler')).toBe(false);
  });

  test('mentions and directs an account', () => {
    const account = ImmutableMap({ acct: 'carol' });
    let state = reduce(
      init(),
      { type: COMPOSE_CHANGE, text: ' hey ' },
      { type: COMPOSE_MENTION, account },
    );
    expect(state.get('text')).toBe('hey @carol ');

    state = reduce(state, { type: COMPOSE_DIRECT, account });
    expect(state.get('text')).toBe('hey @carol @carol ');
    expect(state.get('privacy')).toBe('direct');
  });

  test('submits and resets', () => {
    let state = reduce(
      hydrated({ default_privacy: 'private' }),
      { type: COMPOSE_CHANGE, text: 'x' },
      { type: COMPOSE_SUBMIT_REQUEST },
    );
    expect(state.get('is_submitting')).toBe(true);

    expect(
      reduce(state, { type: COMPOSE_SUBMIT_FAIL }).get('is_submitting'),
    ).toBe(false);

    state = reduce(state, { type: COMPOSE_SUBMIT_SUCCESS });
    expect(state.get('is_submitting')).toBe(false);
    expect(state.get('text')).toBe('');
    expect(state.get('privacy')).toBe('private');

    expect(
      reduce(state, { type: COMPOSE_CHANGE, text: 'y' }, { type: COMPOSE_RESET })
        .get('text'),
    ).toBe('');
  });

  test('uploads, processes, fails and undoes media', () => {
    const file = new File(['x'], 'x.png');
    let state = reduce(
      hydrated({ default_sensitive: true }),
      { type: COMPOSE_UPLOAD_REQUEST },
      { type: COMPOSE_UPLOAD_REQUEST },
      { type: COMPOSE_UPLOAD_PROCESSING },
      { type: COMPOSE_UPLOAD_PROGRESS, loaded: 1, total: 3 },
    );
    expect(state.get('is_uploading')).toBe(true);
    expect(state.get('is_processing')).toBe(true);
    expect(state.get('pending_media_attachments')).toBe(2);
    expect(state.get('progress')).toBe(33);

    state = reduce(state, {
      type: COMPOSE_UPLOAD_SUCCESS,
      media: media('m1'),
      file,
    });
    const attachment = state.get('media_attachments').get(0);
    expect(attachment?.get('id')).toBe('m1');
    expect(attachment?.get('unattached')).toBe(true);
    expect(attachment?.get('file')).toBe(file);
    expect(state.get('is_uploading')).toBe(false);
    expect(state.get('is_processing')).toBe(false);
    expect(state.get('pending_media_attachments')).toBe(1);
    expect(state.get('sensitive')).toBe(true);
    expect(state.get('spoiler')).toBe(true);

    state = reduce(state, { type: COMPOSE_UPLOAD_FAIL });
    expect(state.get('pending_media_attachments')).toBe(0);
    expect(state.get('progress')).toBe(0);

    state = reduce(
      state,
      { type: COMPOSE_UPLOAD_SUCCESS, media: media('m2', 'video'), file },
      { type: COMPOSE_CHANGE_MEDIA_ORDER, a: 'm2', b: 'm1' },
    );
    expect(
      state
        .get('media_attachments')
        .map((item) => item.get('id'))
        .toArray(),
    ).toEqual(['m2', 'm1']);
    expect(state.get('media_attachments').get(0)?.has('file')).toBe(false);

    state = reduce(
      state,
      { type: COMPOSE_UPLOAD_UNDO, media_id: 'm2' },
      { type: COMPOSE_UPLOAD_UNDO, media_id: 'm1' },
    );
    expect(state.get('media_attachments').size).toBe(0);
    expect(state.get('sensitive')).toBe(false);
  });

  test('uploads a thumbnail', () => {
    let state = reduce(
      init(),
      { type: COMPOSE_UPLOAD_SUCCESS, media: media('m1', 'audio'), file: null },
      { type: THUMBNAIL_UPLOAD_REQUEST },
      { type: THUMBNAIL_UPLOAD_PROGRESS, loaded: 5, total: 10 },
    );
    expect(state.get('isUploadingThumbnail')).toBe(true);
    expect(state.get('thumbnailProgress')).toBe(50);

    expect(
      reduce(state, { type: THUMBNAIL_UPLOAD_FAIL }).get('isUploadingThumbnail'),
    ).toBe(false);

    state = reduce(state, {
      type: THUMBNAIL_UPLOAD_SUCCESS,
      media: { ...media('m1', 'audio'), preview_url: 'https://example.com/t' },
    });
    expect(state.get('isUploadingThumbnail')).toBe(false);
    expect(
      state.get('media_attachments').get(0)?.get('preview_url'),
    ).toBe('https://example.com/t');
    expect(state.get('media_attachments').get(0)?.get('unattached')).toBe(true);
  });

  test('changes an upload', () => {
    let state = reduce(init(), {
      type: COMPOSE_UPLOAD_SUCCESS,
      media: media('m1'),
      file: null,
    });

    state = reduce(state, changeUploadCompose.pending('r', { id: 'm1', description: 'd', focus: '' }));
    expect(state.get('is_changing_upload')).toBe(true);

    state = reduce(
      state,
      changeUploadCompose.fulfilled(
        { media: { ...media('m1'), description: 'alt' }, attached: true },
        'r',
        { id: 'm1', description: 'alt', focus: '' },
      ),
    );
    expect(state.get('is_changing_upload')).toBe(false);
    expect(state.get('media_attachments').get(0)?.get('description')).toBe('alt');
    expect(state.get('media_attachments').get(0)?.get('unattached')).toBe(false);

    state = reduce(
      state,
      changeUploadCompose.pending('r', { id: 'm1', description: 'd', focus: '' }),
      changeUploadCompose.rejected(null, 'r', { id: 'm1', description: 'd', focus: '' }),
    );
    expect(state.get('is_changing_upload')).toBe(false);
  });

  test('suggests, selects and ignores', () => {
    let state = reduce(
      init(),
      { type: COMPOSE_TAG_HISTORY_UPDATE, tags: ['Cats', 'dogs', 'catalog'] },
      { type: COMPOSE_CHANGE, text: 'hello #ca' },
      {
        type: COMPOSE_SUGGESTIONS_READY,
        token: '#ca',
        tags: [tag('cars'), tag('cats')],
      },
    );

    expect(state.get('tagHistory').toArray()).toEqual(['Cats', 'dogs', 'catalog']);
    expect(state.get('suggestion_token')).toBe('#ca');
    expect(state.get('suggestions').toArray()).toEqual([
      { ...tag('cats'), name: 'Cats', type: 'hashtag' },
      { ...tag('cars'), type: 'hashtag' },
      { type: 'hashtag', name: 'catalog' },
    ]);

    state = reduce(state, { type: COMPOSE_SUGGESTION_TAGS_UPDATE, token: '#c' });
    expect(state.get('suggestion_token')).toBe('#c');
    expect(state.get('suggestions').size).toBe(3);

    const selected = reduce(state, {
      type: COMPOSE_SUGGESTION_SELECT,
      position: 6,
      token: '#ca',
      completion: '#cats',
      path: ['text'],
    });
    expect(selected.get('text')).toBe('hello #cats ');
    expect(selected.get('caretPosition')).toBe(12);
    expect(selected.get('focusDate')).toBeInstanceOf(Date);
    expect(selected.get('suggestions').size).toBe(0);
    expect(selected.get('suggestion_token')).toBe(null);

    const ignored = reduce(state, {
      type: COMPOSE_SUGGESTION_IGNORE,
      position: 6,
      token: '#ca',
      completion: '#Ca',
      path: ['text'],
    });
    expect(ignored.get('text')).toBe('hello #ca ');
    expect(ignored.get('caretPosition')).toBe(10);

    state = reduce(state, { type: COMPOSE_SUGGESTIONS_CLEAR });
    expect(state.get('suggestions').size).toBe(0);
    expect(state.get('suggestion_token')).toBe(null);

    state = reduce(state, {
      type: COMPOSE_SUGGESTIONS_READY,
      token: '@al',
      accounts: [{ id: '1', acct: 'alice' }],
    });
    expect(state.get('suggestions').toArray()).toEqual([{ id: '1', type: 'account' }]);

    state = reduce(state, {
      type: COMPOSE_SUGGESTIONS_READY,
      token: ':sm',
      emojis: [{ id: 'smile', native: '😄' }],
    });
    expect(state.get('suggestions').toArray()).toEqual([
      { id: 'smile', native: '😄', type: 'emoji' },
    ]);
  });

  test('completes a suggestion in the spoiler text and a poll option', () => {
    const state = reduce(
      init(),
      { type: COMPOSE_SPOILERNESS_CHANGE },
      { type: COMPOSE_SPOILER_TEXT_CHANGE, text: 'about #ca' },
      { type: COMPOSE_POLL_ADD },
      { type: COMPOSE_POLL_OPTION_CHANGE, index: 0, title: 'go :sm', maxOptions: 4 },
      {
        type: COMPOSE_SUGGESTION_SELECT,
        position: 6,
        token: '#ca',
        completion: '#cats',
        path: ['spoiler_text'],
      },
      {
        type: COMPOSE_SUGGESTION_SELECT,
        position: 3,
        token: ':sm',
        completion: '😄',
        path: ['poll', 'options', 0],
      },
    );

    expect(state.get('spoiler_text')).toBe('about #cats ');
    expect(state.get('caretPosition')).toBe(null);
    expect(state.getIn(['poll', 'options', 0])).toBe('go 😄 ');
  });

  test('edits a poll', () => {
    let state = reduce(init(), { type: COMPOSE_POLL_ADD });
    expect(state.get('poll')?.toJS()).toEqual({
      options: ['', ''],
      expires_in: 86400,
      multiple: false,
    });

    state = reduce(
      state,
      { type: COMPOSE_POLL_OPTION_CHANGE, index: 0, title: 'a', maxOptions: 3 },
      { type: COMPOSE_POLL_OPTION_CHANGE, index: 1, title: 'b', maxOptions: 3 },
    );
    expect(state.getIn(['poll', 'options'])).toEqual(ImmutableList(['a', 'b', '']));

    state = reduce(
      state,
      { type: COMPOSE_POLL_OPTION_CHANGE, index: 2, title: 'c', maxOptions: 3 },
    );
    expect(state.getIn(['poll', 'options'])).toEqual(ImmutableList(['a', 'b', 'c']));

    state = reduce(
      state,
      { type: COMPOSE_POLL_OPTION_CHANGE, index: 0, title: ' ', maxOptions: 3 },
      { type: COMPOSE_POLL_SETTINGS_CHANGE, expiresIn: 300, isMultiple: true },
    );
    expect(state.get('poll')?.toJS()).toEqual({
      options: ['b', 'c', ''],
      expires_in: 300,
      multiple: true,
    });

    expect(reduce(state, { type: COMPOSE_POLL_REMOVE }).get('poll')).toBe(null);
  });

  test('inserts an emoji and focuses', () => {
    let state = reduce(
      init(),
      { type: COMPOSE_CHANGE, text: 'ab' },
      {
        type: COMPOSE_EMOJI_INSERT,
        position: 1,
        emoji: { native: '😄' },
        needsSpace: true,
      },
    );
    expect(state.get('text')).toBe('a 😄 b');
    expect(state.get('caretPosition')).toBe(5);

    state = reduce(
      init(),
      { type: COMPOSE_FOCUS, defaultText: '@x ', caretStart: true },
    );
    expect(state.get('text')).toBe('@x ');
    expect(state.get('caretPosition')).toBe(0);
    expect(state.get('focusDate')).toBeInstanceOf(Date);

    state = reduce(state, { type: COMPOSE_FOCUS, defaultText: 'other', caretStart: false });
    expect(state.get('text')).toBe('@x ');
    expect(state.get('caretPosition')).toBe(0);
  });

  test('redrafts a status', () => {
    const poll = {
      id: 'p',
      options: [{ title: 'yes' }, { title: 'no' }],
      multiple: true,
      expires_at: null,
    };
    const state = reduce(init(), {
      type: REDRAFT,
      status: statusOf({
        in_reply_to_id: '5',
        visibility: 'unlisted',
        sensitive: true,
        media_attachments: [media('m1')],
      }).set('poll', poll),
      raw_text: null,
      quoted_status_id: '7',
      maxOptions: 4,
    });

    expect(state.get('text')).toBe('@bob hello');
    expect(state.get('in_reply_to')).toBe('5');
    expect(state.get('privacy')).toBe('unlisted');
    expect(state.get('sensitive')).toBe(true);
    expect(state.get('spoiler')).toBe(true);
    expect(state.get('spoiler_text')).toBe('');
    expect(state.get('language')).toBe('de');
    expect(state.get('id')).toBe(null);
    expect(state.get('quoted_status_id')).toBe('7');
    expect(state.get('quote_policy')).toBe('followers');
    expect(state.get('media_attachments').get(0)?.get('unattached')).toBe(true);
    expect(state.get('poll')?.toJS()).toEqual({
      options: ['yes', 'no', ''],
      multiple: true,
      expires_in: 86400,
    });

    const withText = reduce(init(), {
      type: REDRAFT,
      status: statusOf({ spoiler_text: 'cw', quote_approval: null }),
      raw_text: 'raw',
      quoted_status_id: null,
      maxOptions: 4,
    });
    expect(withText.get('text')).toBe('raw');
    expect(withText.get('spoiler')).toBe(true);
    expect(withText.get('spoiler_text')).toBe('cw');
    expect(withText.get('quote_policy')).toBe('nobody');
    expect(withText.get('poll')).toBe(null);
  });

  test('redrafts a status whose mention has no link in its content', () => {
    const state = reduce(init(), {
      type: REDRAFT,
      status: statusOf({ content: '<p>hello</p>' }),
      raw_text: null,
      quoted_status_id: null,
      maxOptions: 4,
    });

    expect(state.get('text')).toBe('hello');
  });

  test('sets the form to a status being edited', () => {
    const expiresAt = new Date(Date.now() + 3000 * 1000).toISOString();
    const state = reduce(init(), {
      type: COMPOSE_SET_STATUS,
      status: statusOf({
        quote: { state: 'accepted', quoted_status: '9' },
        media_attachments: [media('m1')],
      }).set('poll', {
        id: 'p',
        options: [{ title: 'a' }, { title: 'b' }],
        multiple: false,
        expires_at: expiresAt,
      }),
      text: 'source',
      spoiler_text: '',
      maxOptions: 2,
    });

    expect(state.get('id')).toBe('10');
    expect(state.get('text')).toBe('source');
    expect(state.get('privacy')).toBe('public');
    expect(state.get('quoted_status_id')).toBe('9');
    expect(state.get('spoiler')).toBe(false);
    expect(state.get('media_attachments').get(0)?.has('unattached')).toBe(false);
    expect(state.get('poll')?.toJS()).toEqual({
      options: ['a', 'b'],
      multiple: false,
      expires_in: 3600,
    });

    expect(
      reduce(init(), {
        type: COMPOSE_SET_STATUS,
        status: statusOf({}),
        text: 't',
        spoiler_text: 'cw',
        maxOptions: 4,
      }).get('quoted_status_id'),
    ).toBe(null);
  });

  test('forgets a deleted status it replies to or edits', () => {
    const replying = reduce(init(), {
      type: COMPOSE_REPLY,
      status: statusOf({}),
    });
    const deleted = timelineDelete({
      statusId: '10',
      accountId: '1',
      references: [],
      reblogOf: null,
    });
    expect(reduce(replying, deleted).get('in_reply_to')).toBe(null);

    const editing = reduce(init(), {
      type: COMPOSE_SET_STATUS,
      status: statusOf({}),
      text: '',
      spoiler_text: '',
      maxOptions: 4,
    });
    expect(reduce(editing, deleted).get('id')).toBe(null);
    expect(reduce(editing, { ...deleted, payload: { ...deleted.payload, statusId: '11' } })).toBe(editing);
  });

  test('quotes and sets the quote policy', () => {
    const quoted = statusOf({ id: '20', visibility: 'private', spoiler_text: 'q' });
    let state = reduce(init(), {
      type: changeComposeVisibility.type,
      payload: 'unlisted',
      meta: { arg: 'unlisted' },
    });
    expect(state.get('privacy')).toBe('unlisted');

    state = reduce(state, {
      type: quoteCompose.type,
      payload: quoted,
      meta: { arg: quoted },
    });
    expect(state.get('quoted_status_id')).toBe('20');
    expect(state.get('spoiler')).toBe(true);
    expect(state.get('spoiler_text')).toBe('q');
    expect(state.get('privacy')).toBe('private');

    state = reduce(state, quoteComposeCancel(), setComposeQuotePolicy('nobody'));
    expect(state.get('quoted_status_id')).toBe(null);
    expect(state.get('quote_policy')).toBe('nobody');

    state = reduce(
      state,
      { type: changeComposeVisibility.type, payload: 'direct', meta: { arg: 'direct' } },
      { type: quoteCompose.type, payload: quoted, meta: { arg: quoted } },
    );
    expect(state.get('quoted_status_id')).toBe(null);
  });

  test('tracks the pasted link request and drag uploads', () => {
    let state = reduce(init(), pasteLinkCompose.pending('a', { url: 'u' }));
    expect(state.get('fetching_link')).toBe('a');

    expect(
      reduce(state, pasteLinkCompose.rejected(null, 'b', { url: 'u' })).get('fetching_link'),
    ).toBe('a');
    expect(
      reduce(state, pasteLinkCompose.rejected(null, 'a', { url: 'u' })).get('fetching_link'),
    ).toBe(null);
    expect(reduce(state, cancelPasteLinkCompose()).get('fetching_link')).toBe(null);

    state = reduce(state, setDragUploadEnabled(false));
    expect(state.get('isDragDisabled')).toBe(true);
  });
});
