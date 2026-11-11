import type { Reducer } from '@reduxjs/toolkit';
import {
  Map as ImmutableMap,
  List as ImmutableList,
  OrderedSet as ImmutableOrderedSet,
  fromJS,
  isMap,
} from 'immutable';

import type { ApiQuotePolicy, StatusVisibility } from '@tstodon/api';
import {
  STATUS_VISIBILITIES,
  isQuotePolicyName,
  isStatusVisibility,
} from '@tstodon/api/values';

import {
  changeComposeVisibility,
  changeUploadCompose,
  quoteCompose,
  quoteComposeCancel,
  setComposeQuotePolicy,
  pasteLinkCompose,
  cancelPasteLinkCompose,
  setDragUploadEnabled,
} from '@/mastodon/actions/compose_typed';
import { timelineDelete } from 'mastodon/actions/timelines_typed';
import type { ApiHashtagJSON } from 'mastodon/api_types/tags';
import type { MediaAttachment } from 'mastodon/models/media_attachment';
import type { Poll } from 'mastodon/models/poll';
import type { AnyStatus } from 'mastodon/models/status';
import { immutableMapOf } from 'mastodon/utils/immutable_map_of';
import type { ImmutableMapOf } from 'mastodon/utils/immutable_map_of';

import {
  COMPOSE_MOUNT,
  COMPOSE_UNMOUNT,
  COMPOSE_CHANGE,
  COMPOSE_REPLY,
  COMPOSE_REPLY_CANCEL,
  COMPOSE_DIRECT,
  COMPOSE_MENTION,
  COMPOSE_SUBMIT_REQUEST,
  COMPOSE_SUBMIT_SUCCESS,
  COMPOSE_SUBMIT_FAIL,
  COMPOSE_UPLOAD_REQUEST,
  COMPOSE_UPLOAD_SUCCESS,
  COMPOSE_UPLOAD_FAIL,
  COMPOSE_UPLOAD_UNDO,
  COMPOSE_UPLOAD_PROGRESS,
  COMPOSE_UPLOAD_PROCESSING,
  THUMBNAIL_UPLOAD_REQUEST,
  THUMBNAIL_UPLOAD_SUCCESS,
  THUMBNAIL_UPLOAD_FAIL,
  THUMBNAIL_UPLOAD_PROGRESS,
  COMPOSE_SUGGESTIONS_CLEAR,
  COMPOSE_SUGGESTIONS_READY,
  COMPOSE_SUGGESTION_SELECT,
  COMPOSE_SUGGESTION_IGNORE,
  COMPOSE_SUGGESTION_TAGS_UPDATE,
  COMPOSE_TAG_HISTORY_UPDATE,
  COMPOSE_SENSITIVITY_CHANGE,
  COMPOSE_SPOILERNESS_CHANGE,
  COMPOSE_SPOILER_TEXT_CHANGE,
  COMPOSE_LANGUAGE_CHANGE,
  COMPOSE_COMPOSING_CHANGE,
  COMPOSE_EMOJI_INSERT,
  COMPOSE_RESET,
  COMPOSE_POLL_ADD,
  COMPOSE_POLL_REMOVE,
  COMPOSE_POLL_OPTION_CHANGE,
  COMPOSE_POLL_SETTINGS_CHANGE,
  COMPOSE_CHANGE_MEDIA_ORDER,
  COMPOSE_SET_STATUS,
  COMPOSE_FOCUS,
} from '../actions/compose';
import type {
  ComposeFocusAction,
  ComposeMentionAction,
  ComposeReplyAction,
  ComposeSetStatusAction,
  ComposeSuggestion,
  ComposeSuggestionPath,
  ComposeSuggestionSelectAction,
  addPoll,
  cancelReplyCompose,
  changeCompose,
  changeComposeLanguage,
  changeComposeSensitivity,
  changeComposeSpoilerText,
  changeComposeSpoilerness,
  changeComposing,
  changeMediaOrder,
  changePollOption,
  changePollSettings,
  clearComposeSuggestions,
  insertEmojiCompose,
  mountCompose,
  readyComposeSuggestionsAccounts,
  readyComposeSuggestionsEmojis,
  readyComposeSuggestionsTags,
  removePoll,
  resetCompose,
  submitComposeFail,
  submitComposeRequest,
  submitComposeSuccess,
  undoUploadCompose,
  unmountCompose,
  updateSuggestionTags,
  updateTagHistory,
  uploadComposeFail,
  uploadComposeProcessing,
  uploadComposeProgress,
  uploadComposeRequest,
  uploadComposeSuccess,
  uploadThumbnailFail,
  uploadThumbnailProgress,
  uploadThumbnailRequest,
  uploadThumbnailSuccess,
} from '../actions/compose';
import { REDRAFT } from '../actions/statuses';
import type { RedraftAction } from '../actions/statuses';
import { STORE_HYDRATE } from '../actions/store';
import { me } from '../initial_state';
import { unescapeHTML } from '../utils/html';
import { uuid } from '../uuid';

import { matchAction } from './match_action';

type ComposePollFields = {
  options: ImmutableList<string>;
  /** Seconds. */
  expires_in: number;
  multiple: boolean;
};

/** The poll being composed. */
export type ComposePoll = ImmutableMapOf<ComposePollFields>;

type ComposeFields = {
  mounted: number;
  sensitive: boolean;
  spoiler: boolean;
  spoiler_text: string;
  privacy: StatusVisibility | null;
  /** The status being edited. */
  id: string | null;
  text: string;
  focusDate: Date | null;
  caretPosition: number | null;
  preselectDate: Date | null;
  in_reply_to: string | null;
  is_composing: boolean;
  is_submitting: boolean;
  is_changing_upload: boolean;
  is_uploading: boolean;
  /** Not set until the first upload. */
  is_processing?: boolean;
  isDragDisabled: boolean;
  should_redirect_to_compose_page: boolean;
  progress: number;
  isUploadingThumbnail: boolean;
  thumbnailProgress: number;
  media_attachments: ImmutableList<MediaAttachment>;
  pending_media_attachments: number;
  poll: ComposePoll | null;
  suggestion_token: string | null;
  suggestions: ImmutableList<ComposeSuggestion>;
  default_privacy: StatusVisibility;
  default_sensitive: boolean;
  default_language: string;
  /** Not set until the hydration (the default language); `null` from a status without one. */
  language?: string | null;
  resetFileKey: number;
  idempotencyKey: string | null;
  tagHistory: ImmutableList<string>;

  // Quotes
  quoted_status_id: string | null;
  quote_policy: ApiQuotePolicy;
  default_quote_policy: ApiQuotePolicy;
  fetching_link: string | null;

  /** The viewer's account id, merged in by the hydration (nothing reads it here). */
  me?: string;
};

export type ComposeState = ImmutableMapOf<ComposeFields>;

const initialState: ComposeState = immutableMapOf<ComposeFields>({
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
  media_attachments: ImmutableList(),
  pending_media_attachments: 0,
  poll: null,
  suggestion_token: null,
  suggestions: ImmutableList(),
  default_privacy: 'public',
  default_sensitive: false,
  default_language: 'en',
  resetFileKey: Math.floor(Math.random() * 0x10000),
  idempotencyKey: null,
  tagHistory: ImmutableList(),

  // Quotes
  quoted_status_id: null,
  quote_policy: 'public',
  default_quote_policy: 'public', // Set in hydration.
  fetching_link: null,
});

const initialPoll: ComposePoll = immutableMapOf<ComposePollFields>({
  options: ImmutableList(['', '']),
  expires_in: 24 * 3600,
  multiple: false,
});

/** The plain-object actions this reducer handles (`isComposeAction`). */
type ComposeAction =
  | ReturnType<
      | typeof mountCompose
      | typeof unmountCompose
      | typeof changeCompose
      | typeof cancelReplyCompose
      | typeof resetCompose
      | typeof submitComposeRequest
      | typeof submitComposeSuccess
      | typeof submitComposeFail
      | typeof uploadComposeRequest
      | typeof uploadComposeSuccess
      | typeof uploadComposeFail
      | typeof undoUploadCompose
      | typeof uploadComposeProgress
      | typeof uploadComposeProcessing
      | typeof uploadThumbnailRequest
      | typeof uploadThumbnailSuccess
      | typeof uploadThumbnailFail
      | typeof uploadThumbnailProgress
      | typeof clearComposeSuggestions
      | typeof readyComposeSuggestionsAccounts
      | typeof readyComposeSuggestionsEmojis
      | typeof readyComposeSuggestionsTags
      | typeof updateSuggestionTags
      | typeof updateTagHistory
      | typeof changeComposeSensitivity
      | typeof changeComposeSpoilerness
      | typeof changeComposeSpoilerText
      | typeof changeComposeLanguage
      | typeof changeComposing
      | typeof insertEmojiCompose
      | typeof addPoll
      | typeof removePoll
      | typeof changePollOption
      | typeof changePollSettings
      | typeof changeMediaOrder
    >
  | ComposeReplyAction
  | ComposeMentionAction
  | ComposeFocusAction
  | ComposeSetStatusAction
  | ComposeSuggestionSelectAction
  | RedraftAction;

/** Whether `action` is one of the {@link ComposeAction}s, by its type. */
const isComposeAction = matchAction<ComposeAction>(
  COMPOSE_MOUNT,
  COMPOSE_UNMOUNT,
  COMPOSE_CHANGE,
  COMPOSE_REPLY,
  COMPOSE_REPLY_CANCEL,
  COMPOSE_DIRECT,
  COMPOSE_MENTION,
  COMPOSE_SUBMIT_REQUEST,
  COMPOSE_SUBMIT_SUCCESS,
  COMPOSE_SUBMIT_FAIL,
  COMPOSE_UPLOAD_REQUEST,
  COMPOSE_UPLOAD_SUCCESS,
  COMPOSE_UPLOAD_FAIL,
  COMPOSE_UPLOAD_UNDO,
  COMPOSE_UPLOAD_PROGRESS,
  COMPOSE_UPLOAD_PROCESSING,
  THUMBNAIL_UPLOAD_REQUEST,
  THUMBNAIL_UPLOAD_SUCCESS,
  THUMBNAIL_UPLOAD_FAIL,
  THUMBNAIL_UPLOAD_PROGRESS,
  COMPOSE_SUGGESTIONS_CLEAR,
  COMPOSE_SUGGESTIONS_READY,
  COMPOSE_SUGGESTION_SELECT,
  COMPOSE_SUGGESTION_IGNORE,
  COMPOSE_SUGGESTION_TAGS_UPDATE,
  COMPOSE_TAG_HISTORY_UPDATE,
  COMPOSE_SENSITIVITY_CHANGE,
  COMPOSE_SPOILERNESS_CHANGE,
  COMPOSE_SPOILER_TEXT_CHANGE,
  COMPOSE_LANGUAGE_CHANGE,
  COMPOSE_COMPOSING_CHANGE,
  COMPOSE_EMOJI_INSERT,
  COMPOSE_RESET,
  COMPOSE_POLL_ADD,
  COMPOSE_POLL_REMOVE,
  COMPOSE_POLL_OPTION_CHANGE,
  COMPOSE_POLL_SETTINGS_CHANGE,
  COMPOSE_CHANGE_MEDIA_ORDER,
  COMPOSE_SET_STATUS,
  COMPOSE_FOCUS,
  REDRAFT,
);

// A status is read in any of its forms (`AnyStatus`): a reply carries its
// account, a redraft or an edit its poll, in place of the id.

const statusVisibility = (status: AnyStatus) => status.get('visibility');

const statusSpoilerText = (status: AnyStatus) => status.get('spoiler_text');

/** The status's attachments, as the form keeps them. */
const statusMediaAttachments = (
  status: AnyStatus,
): ImmutableList<MediaAttachment> => status.get('media_attachments');

const statusMentions = (status: AnyStatus) => status.get('mentions');

/** The status's first automatic quote approval policy, else `nobody`. */
const statusQuotePolicy = (status: AnyStatus): ApiQuotePolicy =>
  // Mastodon-authored posts can be expected to have at most one automatic approval policy
  status.get('quote_approval')?.get('automatic').first() ?? 'nobody';

/** An attachment as `fromJS` converts it (a `Map` with string keys). */
const mediaAttachmentFromJSON = (media: object): MediaAttachment =>
  ImmutableMap<string, unknown>(fromJS(media));

function statusToTextMentions(status: AnyStatus) {
  let set = ImmutableOrderedSet<string>([]);

  if (status.getIn(['account', 'id']) !== me) {
    set = set.add(`@${String(status.getIn(['account', 'acct']))} `);
  }

  return set
    .union(
      statusMentions(status)
        .filterNot((mention) => mention.get('id') === me)
        .map((mention) => `@${String(mention.get('acct'))} `),
    )
    .join('');
}

function clearAll(state: ComposeState) {
  return state.withMutations((map) => {
    map.set('id', null);
    map.set('text', '');
    map.set('spoiler', false);
    map.set('spoiler_text', '');
    map.set('is_submitting', false);
    map.set('is_changing_upload', false);
    map.set('in_reply_to', null);
    map.set('privacy', state.get('default_privacy'));
    map.set('sensitive', state.get('default_sensitive'));
    map.set('language', state.get('default_language'));
    map.update('media_attachments', (list) => list.clear());
    map.set('progress', 0);
    map.set('poll', null);
    map.set('idempotencyKey', uuid());
    map.set('quoted_status_id', null);
    map.set('quote_policy', state.get('default_quote_policy'));
    map.set('isDragDisabled', false);
  });
}

function appendMedia(state: ComposeState, media: MediaAttachment, file: File) {
  const prevSize = state.get('media_attachments').size;

  return state.withMutations((map) => {
    if (media.get('type') === 'image') {
      media = media.set('file', file);
    }
    map.update('media_attachments', (list) =>
      list.push(media.set('unattached', true)),
    );
    map.set('is_uploading', false);
    map.set('is_processing', false);
    map.set('progress', 0);
    map.set('resetFileKey', Math.floor(Math.random() * 0x10000));
    map.set('idempotencyKey', uuid());
    map.update('pending_media_attachments', (n) => n - 1);

    if (
      prevSize === 0 &&
      (state.get('default_sensitive') || state.get('spoiler'))
    ) {
      map.set('sensitive', true);

      if (state.get('default_sensitive')) {
        map.set('spoiler', true);
      }
    }
  });
}

function removeMedia(state: ComposeState, mediaId: string) {
  const prevSize = state.get('media_attachments').size;

  return state.withMutations((map) => {
    map.update('media_attachments', (list) =>
      list.filterNot((item) => item.get('id') === mediaId),
    );
    map.set('idempotencyKey', uuid());

    if (prevSize === 1) {
      map.set('sensitive', false);
    }
  });
}

/** Updates the text a suggestion goes into. */
const updateSuggestionText = (
  state: ComposeState,
  path: ComposeSuggestionPath,
  updater: (text: string) => string,
) => {
  if (path[0] === 'poll') {
    const index = path[2];
    return state.update(
      'poll',
      (poll) =>
        poll?.update('options', (options) =>
          options.update(index, (text) => updater(text ?? '')),
        ) ?? null,
    );
  }

  return state.update(path[0], updater);
};

const insertSuggestion = (
  state: ComposeState,
  position: number,
  token: string,
  completion: string,
  path: ComposeSuggestionPath,
) => {
  return updateSuggestionText(
    state,
    path,
    (oldText) =>
      `${oldText.slice(0, position)}${completion} ${oldText.slice(position + token.length)}`,
  ).withMutations((map) => {
    map.set('suggestion_token', null);
    map.set('suggestions', ImmutableList());
    if (path.length === 1 && path[0] === 'text') {
      map.set('focusDate', new Date());
      map.set('caretPosition', position + completion.length + 1);
    }
    map.set('idempotencyKey', uuid());
  });
};

const ignoreSuggestion = (
  state: ComposeState,
  position: number,
  token: string,
  path: ComposeSuggestionPath,
) => {
  return updateSuggestionText(
    state,
    path,
    (oldText) =>
      `${oldText.slice(0, position + token.length)} ${oldText.slice(position + token.length)}`,
  ).withMutations((map) => {
    map.set('suggestion_token', null);
    map.set('suggestions', ImmutableList());
    map.set('focusDate', new Date());
    map.set('caretPosition', position + token.length + 1);
    map.set('idempotencyKey', uuid());
  });
};

type HashtagSuggestion = Extract<ComposeSuggestion, { type: 'hashtag' }>;

/** Puts the hashtags the viewer used before first, keeping the order otherwise. */
const sortHashtagsByUse = (
  state: ComposeState,
  tags: (ApiHashtagJSON & { type: 'hashtag' })[],
) => {
  const personalHistory = state
    .get('tagHistory')
    .map((tag) => tag.toLowerCase());

  return tags
    .map((tag) => ({
      tag,
      used: personalHistory.includes(tag.name.toLowerCase()),
    }))
    .sort((a, b) => {
      if (a.used === b.used) {
        return 0;
      } else if (a.used && !b.used) {
        return -1;
      } else {
        return 1;
      }
    })
    .map(({ tag }) => tag);
};

const insertEmoji = (
  state: ComposeState,
  position: number,
  emojiData: { native: string },
  needsSpace: boolean,
) => {
  const oldText = state.get('text');
  const emoji = needsSpace ? ' ' + emojiData.native : emojiData.native;

  return state.merge({
    text: `${oldText.slice(0, position)}${emoji} ${oldText.slice(position)}`,
    focusDate: new Date(),
    caretPosition: position + emoji.length + 1,
    idempotencyKey: uuid(),
  });
};

const privacyPreference = (
  a: StatusVisibility | null,
  b: StatusVisibility,
): StatusVisibility => {
  // From most to least public (@tstodon/api's STATUS_VISIBILITIES).
  const order = STATUS_VISIBILITIES;
  return (
    order[Math.max(a === null ? -1 : order.indexOf(a), order.indexOf(b), 0)] ??
    'public'
  );
};

/**
 * The initial state's `compose` (`ApiInitialStateComposeJSON`), as
 * `hydrateStore` converted it to an Immutable map.
 */
const hydratedFields = (hydrated: unknown): Partial<ComposeFields> | null => {
  const compose: unknown = isMap(hydrated) ? hydrated.get('compose') : null;
  if (!isMap(compose)) {
    return null;
  }

  const fields: Partial<ComposeFields> = {};
  const me = compose.get('me');
  const defaultPrivacy = compose.get('default_privacy');
  const defaultSensitive = compose.get('default_sensitive');
  const defaultLanguage = compose.get('default_language');
  const defaultQuotePolicy = compose.get('default_quote_policy');
  const text = compose.get('text');

  if (typeof me === 'string') fields.me = me;
  if (typeof defaultPrivacy === 'string' && isStatusVisibility(defaultPrivacy))
    fields.default_privacy = defaultPrivacy;
  if (typeof defaultSensitive === 'boolean')
    fields.default_sensitive = defaultSensitive;
  if (typeof defaultLanguage === 'string')
    fields.default_language = defaultLanguage;
  if (
    typeof defaultQuotePolicy === 'string' &&
    isQuotePolicyName(defaultQuotePolicy)
  )
    fields.default_quote_policy = defaultQuotePolicy;
  if (typeof text === 'string') fields.text = text;

  return fields;
};

const hydrate = (
  state: ComposeState,
  hydratedState: Partial<ComposeFields>,
) => {
  state = clearAll(state.merge(hydratedState));

  if (hydratedState.text) {
    state = state.set('text', hydratedState.text).set('focusDate', new Date());
  }

  return state;
};

const domParser = new DOMParser();

const expandMentions = (status: AnyStatus) => {
  const fragment = domParser.parseFromString(
    status.get('content'),
    'text/html',
  ).documentElement;

  statusMentions(status).forEach((mention) => {
    const link = fragment.querySelector(
      `a[href="${String(mention.get('url'))}"]`,
    );
    if (link) {
      link.textContent = `@${String(mention.get('acct'))}`;
    }
  });

  return fragment.innerHTML;
};

const expiresInFromExpiresAt = (expires_at: string | null | undefined) => {
  if (!expires_at) return 24 * 3600;
  const delta = (new Date(expires_at).getTime() - Date.now()) / 1000;
  return (
    [300, 1800, 3600, 21600, 86400, 259200, 604800].find(
      (expires_in) => expires_in >= delta,
    ) ?? 24 * 3600
  );
};

/** The poll of a status as a compose poll, with an empty option if one fits. */
const composePollOf = (poll: Poll, maxOptions: number | undefined) => {
  let options = ImmutableList(poll.options.map((x) => x.title));
  if (maxOptions !== undefined && options.size < maxOptions) {
    options = options.push('');
  }

  return immutableMapOf<ComposePollFields>({
    options: options,
    multiple: poll.multiple,
    expires_in: expiresInFromExpiresAt(poll.expires_at),
  });
};

const mergeLocalHashtagResults = (
  suggestions: ComposeSuggestion[],
  prefix: string,
  tagHistory: ImmutableList<string>,
) => {
  prefix = prefix.toLowerCase();

  if (suggestions.length < 4) {
    const localTags = tagHistory.filter(
      (tag) =>
        tag.toLowerCase().startsWith(prefix) &&
        !suggestions.some(
          (suggestion) =>
            suggestion.type === 'hashtag' &&
            suggestion.name.toLowerCase() === tag.toLowerCase(),
        ),
    );
    suggestions = suggestions.concat(
      localTags
        .slice(0, 4 - suggestions.length)
        .toArray()
        .map((tag): HashtagSuggestion => ({ type: 'hashtag', name: tag })),
    );
  }

  // Prefer capitalization from personal history, unless personal history is all lower-case
  const fixSuggestionCapitalization = (
    suggestion: ComposeSuggestion,
  ): ComposeSuggestion => {
    if (suggestion.type !== 'hashtag') return suggestion;

    const tagFromHistory = tagHistory.find(
      (tag) =>
        tag.localeCompare(suggestion.name, undefined, {
          sensitivity: 'accent',
        }) === 0,
    );

    if (!tagFromHistory || tagFromHistory.toLowerCase() === tagFromHistory)
      return suggestion;

    return { ...suggestion, name: tagFromHistory };
  };

  return suggestions.map(fixSuggestionCapitalization);
};

const normalizeSuggestions = (
  state: ComposeState,
  action:
    | ReturnType<typeof readyComposeSuggestionsAccounts>
    | ReturnType<typeof readyComposeSuggestionsEmojis>
    | ReturnType<typeof readyComposeSuggestionsTags>,
): ComposeSuggestion[] => {
  if ('accounts' in action) {
    return action.accounts.map((item) => ({
      id: item.id,
      type: 'account' as const,
    }));
  } else if ('emojis' in action) {
    return action.emojis.map((item) => ({ ...item, type: 'emoji' as const }));
  } else {
    return mergeLocalHashtagResults(
      sortHashtagsByUse(
        state,
        action.tags.map((item) => ({ ...item, type: 'hashtag' as const })),
      ),
      action.token.slice(1),
      state.get('tagHistory'),
    );
  }
};

const updateSuggestionTagsOf = (state: ComposeState, token: string) => {
  const prefix = token.slice(1);

  const suggestions = state.get('suggestions').toArray();
  return state.merge({
    suggestions: ImmutableList(
      mergeLocalHashtagResults(suggestions, prefix, state.get('tagHistory')),
    ),
    suggestion_token: token,
  });
};

const updatePoll = (
  state: ComposeState,
  index: number,
  value: string,
  maxOptions: number,
) =>
  state.update(
    'poll',
    (poll) =>
      poll?.update('options', (options) => {
        const tmp = options
          .set(index, value)
          .filterNot((x) => x.trim().length === 0);

        if (tmp.size === 0) {
          return tmp.push('').push('');
        } else if (tmp.size < maxOptions) {
          return tmp.push('');
        }

        return tmp;
      }) ?? null,
  );

const calculateProgress = (loaded: number, total: number) =>
  Math.min(Math.round((loaded / total) * 100), 100);

/** Sets the form (in `withMutations`) to a status, to redraft or edit it. */
const setToStatus = (
  map: ComposeState,
  status: AnyStatus,
  spoilerText: string,
  maxOptions: number | undefined,
) => {
  map.set('in_reply_to', status.get('in_reply_to_id'));
  map.set('privacy', statusVisibility(status));
  map.set('focusDate', new Date());
  map.set('caretPosition', null);
  map.set('idempotencyKey', uuid());
  map.set('sensitive', status.get('sensitive') === true);
  map.set('language', status.get('language'));
  map.set('quote_policy', statusQuotePolicy(status));

  if (spoilerText.length > 0) {
    map.set('spoiler', true);
    map.set('spoiler_text', spoilerText);
  } else {
    map.set(
      'spoiler',
      status.get('sensitive') === true &&
        statusMediaAttachments(status).size > 0,
    );
    map.set('spoiler_text', '');
  }

  // The poll `statusWithPoll` (`actions/statuses.ts`) put into the status.
  const poll = status.get('poll');
  if (poll && typeof poll !== 'string') {
    map.set('poll', composePollOf(poll, maxOptions));
  }
};

export const composeReducer: Reducer<ComposeState> = (
  state = initialState,
  action,
) => {
  if (changeComposeVisibility.match(action)) {
    return state.set('privacy', action.payload).set('idempotencyKey', uuid());
  } else if (changeUploadCompose.fulfilled.match(action)) {
    return state.set('is_changing_upload', false).update(
      'media_attachments',
      (list) =>
        list.map((item) => {
          if (item.get('id') === action.payload.media.id) {
            return mediaAttachmentFromJSON(action.payload.media).set(
              'unattached',
              !action.payload.attached,
            );
          }

          return item;
        }),
    );
  } else if (changeUploadCompose.pending.match(action)) {
    return state.set('is_changing_upload', true);
  } else if (changeUploadCompose.rejected.match(action)) {
    return state.set('is_changing_upload', false);
  } else if (quoteCompose.match(action)) {
    const status = action.payload;
    const isDirect = state.get('privacy') === 'direct';
    return state
      .set('quoted_status_id', isDirect ? null : status.get('id'))
      .update('spoiler', (spoiler) => spoiler || !!status.get('spoiler_text'))
      .update(
        'spoiler_text',
        (spoiler_text) => spoiler_text || statusSpoilerText(status),
      )
      .update('privacy', (visibility) => {
        if (
          (visibility === 'public' || visibility === 'unlisted') &&
          status.get('visibility') === 'private'
        ) {
          return 'private';
        }
        return visibility;
      });
  } else if (quoteComposeCancel.match(action)) {
    return state.set('quoted_status_id', null);
  } else if (setComposeQuotePolicy.match(action)) {
    return state.set('quote_policy', action.payload);
  } else if (pasteLinkCompose.pending.match(action)) {
    return state.set('fetching_link', action.meta.requestId);
  } else if (
    pasteLinkCompose.fulfilled.match(action) ||
    pasteLinkCompose.rejected.match(action)
  ) {
    return action.meta.requestId === state.get('fetching_link')
      ? state.set('fetching_link', null)
      : state;
  } else if (cancelPasteLinkCompose.match(action)) {
    return state.set('fetching_link', null);
  } else if (setDragUploadEnabled.match(action)) {
    return state.set('isDragDisabled', !action.payload);
  } else if (timelineDelete.match(action)) {
    if (action.payload.statusId === state.get('in_reply_to')) {
      return state.set('in_reply_to', null);
    } else if (action.payload.statusId === state.get('id')) {
      return state.set('id', null);
    } else {
      return state;
    }
  } else if (action.type === STORE_HYDRATE) {
    const fields = hydratedFields(action.state);
    return fields ? hydrate(state, fields) : state;
  }

  if (!isComposeAction(action)) {
    return state;
  }

  switch (action.type) {
    case COMPOSE_MOUNT:
      return state
        .set('mounted', state.get('mounted') + 1)
        .set('should_redirect_to_compose_page', false);
    case COMPOSE_UNMOUNT:
      return state
        .set('mounted', Math.max(state.get('mounted') - 1, 0))
        .set('is_composing', false)
        .set(
          'should_redirect_to_compose_page',
          state.get('mounted') === 1 &&
            state.get('is_composing') &&
            (state.get('text').trim() !== '' ||
              state.get('media_attachments').size > 0),
        );
    case COMPOSE_SENSITIVITY_CHANGE:
      return state.withMutations((map) => {
        if (!state.get('spoiler')) {
          map.set('sensitive', !state.get('sensitive'));
        }

        map.set('idempotencyKey', uuid());
      });
    case COMPOSE_SPOILERNESS_CHANGE:
      return state.withMutations((map) => {
        map.set('spoiler', !state.get('spoiler'));
        map.set('idempotencyKey', uuid());

        if (state.get('media_attachments').size >= 1) {
          map.set('sensitive', !state.get('spoiler'));
        }
      });
    case COMPOSE_SPOILER_TEXT_CHANGE:
      if (!state.get('spoiler')) return state;
      return state
        .set('spoiler_text', action.text)
        .set('idempotencyKey', uuid());
    case COMPOSE_CHANGE:
      return state.set('text', action.text).set('idempotencyKey', uuid());
    case COMPOSE_COMPOSING_CHANGE:
      return state.set('is_composing', action.value);
    case COMPOSE_REPLY:
      return state.withMutations((map) => {
        const status = action.status;
        const language = status.get('language');
        const spoilerText = statusSpoilerText(status);

        map.set('id', null);
        map.set('in_reply_to', status.get('id'));
        map.set('text', statusToTextMentions(status));
        map.set(
          'privacy',
          privacyPreference(
            statusVisibility(status),
            state.get('default_privacy'),
          ),
        );
        map.set('focusDate', new Date());
        map.set('caretPosition', null);
        map.set('preselectDate', new Date());
        map.set('idempotencyKey', uuid());
        map.set('quoted_status_id', null);

        map.update('media_attachments', (list) =>
          list.filter((media) => media.get('unattached')),
        );

        if (language && !status.has('translation')) {
          map.set('language', language);
        } else {
          map.set('language', state.get('default_language'));
        }

        if (spoilerText.length > 0) {
          map.set('spoiler', true);
          map.set('spoiler_text', spoilerText);

          if (map.get('media_attachments').size >= 1) {
            map.set('sensitive', true);
          }
        } else {
          map.set('spoiler', false);
          map.set('spoiler_text', '');
        }
      });
    case COMPOSE_SUBMIT_REQUEST:
      return state.set('is_submitting', true);

    case COMPOSE_REPLY_CANCEL:
    case COMPOSE_RESET:
    case COMPOSE_SUBMIT_SUCCESS:
      return clearAll(state);
    case COMPOSE_SUBMIT_FAIL:
      return state.set('is_submitting', false);
    case COMPOSE_UPLOAD_REQUEST:
      return state
        .set('is_uploading', true)
        .update('pending_media_attachments', (n) => n + 1);
    case COMPOSE_UPLOAD_PROCESSING:
      return state.set('is_processing', true);
    case COMPOSE_UPLOAD_SUCCESS:
      return appendMedia(
        state,
        mediaAttachmentFromJSON(action.media),
        action.file,
      );
    case COMPOSE_UPLOAD_FAIL:
      return state
        .set('is_uploading', false)
        .set('is_processing', false)
        .set('progress', 0)
        .update('pending_media_attachments', (n) => n - 1);
    case COMPOSE_UPLOAD_UNDO:
      return removeMedia(state, action.media_id);
    case COMPOSE_UPLOAD_PROGRESS:
      return state.set(
        'progress',
        calculateProgress(action.loaded, action.total),
      );
    case THUMBNAIL_UPLOAD_REQUEST:
      return state.set('isUploadingThumbnail', true);
    case THUMBNAIL_UPLOAD_PROGRESS:
      return state.set(
        'thumbnailProgress',
        calculateProgress(action.loaded, action.total),
      );
    case THUMBNAIL_UPLOAD_FAIL:
      return state.set('isUploadingThumbnail', false);
    case THUMBNAIL_UPLOAD_SUCCESS:
      return state.set('isUploadingThumbnail', false).update(
        'media_attachments',
        (list) =>
          list.map((item) => {
            if (item.get('id') === action.media.id) {
              return mediaAttachmentFromJSON(action.media).set(
                'unattached',
                item.get('unattached'),
              );
            }

            return item;
          }),
      );
    case COMPOSE_MENTION:
      return state.withMutations((map) => {
        map.update('text', (text) =>
          [text.trim(), `@${action.account.get('acct')} `]
            .filter((str) => str.length !== 0)
            .join(' '),
        );
        map.set('focusDate', new Date());
        map.set('caretPosition', null);
        map.set('idempotencyKey', uuid());
      });
    case COMPOSE_DIRECT:
      return state.withMutations((map) => {
        map.update('text', (text) =>
          [text.trim(), `@${action.account.get('acct')} `]
            .filter((str) => str.length !== 0)
            .join(' '),
        );
        map.set('privacy', 'direct');
        map.set('focusDate', new Date());
        map.set('caretPosition', null);
        map.set('idempotencyKey', uuid());
      });
    case COMPOSE_SUGGESTIONS_CLEAR:
      return state
        .update('suggestions', ImmutableList(), (list) => list.clear())
        .set('suggestion_token', null);
    case COMPOSE_SUGGESTIONS_READY:
      return state
        .set('suggestions', ImmutableList(normalizeSuggestions(state, action)))
        .set('suggestion_token', action.token);
    case COMPOSE_SUGGESTION_SELECT:
      return insertSuggestion(
        state,
        action.position,
        action.token,
        action.completion,
        action.path,
      );
    case COMPOSE_SUGGESTION_IGNORE:
      return ignoreSuggestion(
        state,
        action.position,
        action.token,
        action.path,
      );
    case COMPOSE_SUGGESTION_TAGS_UPDATE:
      return updateSuggestionTagsOf(state, action.token);
    case COMPOSE_TAG_HISTORY_UPDATE:
      return state.set('tagHistory', fromJS(action.tags));
    case COMPOSE_EMOJI_INSERT:
      return insertEmoji(
        state,
        action.position,
        action.emoji,
        action.needsSpace,
      );
    case REDRAFT:
      return state.withMutations((map) => {
        const status = action.status;

        map.set(
          'text',
          action.raw_text || unescapeHTML(expandMentions(status)),
        );
        map.set(
          'media_attachments',
          statusMediaAttachments(status).map((media) =>
            media.set('unattached', true),
          ),
        );
        map.set('id', null);
        map.set('quoted_status_id', action.quoted_status_id);
        setToStatus(map, status, statusSpoilerText(status), action.maxOptions);
      });
    case COMPOSE_SET_STATUS:
      return state.withMutations((map) => {
        const status = action.status;

        map.set('id', status.get('id'));
        map.set('text', action.text);
        map.set('media_attachments', statusMediaAttachments(status));
        map.set(
          'quoted_status_id',
          status.get('quote')?.get('quoted_status') ?? null,
        );
        setToStatus(map, status, action.spoiler_text, action.maxOptions);
      });
    case COMPOSE_POLL_ADD:
      return state.set('poll', initialPoll);
    case COMPOSE_POLL_REMOVE:
      return state.set('poll', null);
    case COMPOSE_POLL_OPTION_CHANGE:
      return updatePoll(state, action.index, action.title, action.maxOptions);
    case COMPOSE_POLL_SETTINGS_CHANGE:
      return state.update(
        'poll',
        (poll) =>
          poll
            ?.set('expires_in', action.expiresIn)
            .set('multiple', action.isMultiple) ?? null,
      );
    case COMPOSE_LANGUAGE_CHANGE:
      return state.set('language', action.language);
    case COMPOSE_FOCUS:
      return state
        .set('focusDate', new Date())
        .update('text', (text) =>
          text.length > 0 ? text : action.defaultText,
        )
        .update('caretPosition', (position) =>
          action.caretStart ? 0 : position,
        );
    case COMPOSE_CHANGE_MEDIA_ORDER:
      return state.update('media_attachments', (list) => {
        const indexA = list.findIndex((x) => x.get('id') === action.a);
        const moveItem = list.get(indexA);
        const indexB = list.findIndex((x) => x.get('id') === action.b);

        if (moveItem === undefined) {
          return list;
        }

        return list.splice(indexA, 1).splice(indexB, 0, moveItem);
      });
  }
};
