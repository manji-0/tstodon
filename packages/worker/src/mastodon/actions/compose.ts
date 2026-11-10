import { defineMessages } from 'react-intl';

import { isCancel } from 'axios';
import { isList, isMap, List as ImmutableList } from 'immutable';
import { throttle } from 'lodash';

import type {
  ApiCreateStatusParams,
  ApiStatusMediaAttributeParams,
  ApiStatusPollParams,
} from '@tstodon/api';
import {
  apiGetMedia,
  apiUploadMedia,
  apiUploadMediaThumbnail,
} from 'mastodon/api/compose';
import { apiGetSearch, apiSearchAccounts } from 'mastodon/api/search';
import { apiSubmitStatus } from 'mastodon/api/statuses';
import type { ApiAccountJSON } from 'mastodon/api_types/accounts';
import type { ApiMediaAttachmentJSON } from 'mastodon/api_types/media_attachments';
import type { ApiTagJSON, ApiStatusJSON } from 'mastodon/api_types/statuses';
import type { ApiHashtagJSON } from 'mastodon/api_types/tags';
import { browserHistory } from 'mastodon/components/router';
import { countableText } from 'mastodon/features/compose/util/counter';
import type { Account } from 'mastodon/models/account';
import type { Status } from 'mastodon/models/status';
import { tagHistory } from 'mastodon/settings';
import type { AppDispatch, GetState, RootState } from 'mastodon/store';
import { emojiMartSearch } from '@/mastodon/features/emoji/picker';

import { showAlert, showAlertForError } from './alerts';
import { useEmoji } from './emojis';
import { importFetchedAccounts, importFetchedStatus } from './importer';
import { openModal } from './modal';
import { updateTimeline } from './timelines';
import { insertStatusIntoAccountTimelines } from './timelines_typed';

let fetchComposeSuggestionsAccountsController: AbortController | undefined;
let fetchComposeSuggestionsTagsController: AbortController | undefined;
let searchComposeSuggestionsEmojiController: AbortController | undefined;

export const COMPOSE_CHANGE = 'COMPOSE_CHANGE';
export const COMPOSE_SUBMIT_REQUEST = 'COMPOSE_SUBMIT_REQUEST';
export const COMPOSE_SUBMIT_SUCCESS = 'COMPOSE_SUBMIT_SUCCESS';
export const COMPOSE_SUBMIT_FAIL = 'COMPOSE_SUBMIT_FAIL';
export const COMPOSE_REPLY = 'COMPOSE_REPLY';
export const COMPOSE_REPLY_CANCEL = 'COMPOSE_REPLY_CANCEL';
export const COMPOSE_DIRECT = 'COMPOSE_DIRECT';
export const COMPOSE_MENTION = 'COMPOSE_MENTION';
export const COMPOSE_RESET = 'COMPOSE_RESET';

export const COMPOSE_UPLOAD_REQUEST = 'COMPOSE_UPLOAD_REQUEST';
export const COMPOSE_UPLOAD_SUCCESS = 'COMPOSE_UPLOAD_SUCCESS';
export const COMPOSE_UPLOAD_FAIL = 'COMPOSE_UPLOAD_FAIL';
export const COMPOSE_UPLOAD_PROGRESS = 'COMPOSE_UPLOAD_PROGRESS';
export const COMPOSE_UPLOAD_PROCESSING = 'COMPOSE_UPLOAD_PROCESSING';
export const COMPOSE_UPLOAD_UNDO = 'COMPOSE_UPLOAD_UNDO';

export const THUMBNAIL_UPLOAD_REQUEST = 'THUMBNAIL_UPLOAD_REQUEST';
export const THUMBNAIL_UPLOAD_SUCCESS = 'THUMBNAIL_UPLOAD_SUCCESS';
export const THUMBNAIL_UPLOAD_FAIL = 'THUMBNAIL_UPLOAD_FAIL';
export const THUMBNAIL_UPLOAD_PROGRESS = 'THUMBNAIL_UPLOAD_PROGRESS';

export const COMPOSE_SUGGESTIONS_CLEAR = 'COMPOSE_SUGGESTIONS_CLEAR';
export const COMPOSE_SUGGESTIONS_READY = 'COMPOSE_SUGGESTIONS_READY';
export const COMPOSE_SUGGESTION_SELECT = 'COMPOSE_SUGGESTION_SELECT';
export const COMPOSE_SUGGESTION_IGNORE = 'COMPOSE_SUGGESTION_IGNORE';
export const COMPOSE_SUGGESTION_TAGS_UPDATE = 'COMPOSE_SUGGESTION_TAGS_UPDATE';

export const COMPOSE_TAG_HISTORY_UPDATE = 'COMPOSE_TAG_HISTORY_UPDATE';

export const COMPOSE_MOUNT = 'COMPOSE_MOUNT';
export const COMPOSE_UNMOUNT = 'COMPOSE_UNMOUNT';

export const COMPOSE_SENSITIVITY_CHANGE = 'COMPOSE_SENSITIVITY_CHANGE';
export const COMPOSE_SPOILERNESS_CHANGE = 'COMPOSE_SPOILERNESS_CHANGE';
export const COMPOSE_SPOILER_TEXT_CHANGE = 'COMPOSE_SPOILER_TEXT_CHANGE';
export const COMPOSE_COMPOSING_CHANGE = 'COMPOSE_COMPOSING_CHANGE';
export const COMPOSE_LANGUAGE_CHANGE = 'COMPOSE_LANGUAGE_CHANGE';

export const COMPOSE_EMOJI_INSERT = 'COMPOSE_EMOJI_INSERT';

export const COMPOSE_POLL_ADD = 'COMPOSE_POLL_ADD';
export const COMPOSE_POLL_REMOVE = 'COMPOSE_POLL_REMOVE';
export const COMPOSE_POLL_OPTION_ADD = 'COMPOSE_POLL_OPTION_ADD';
export const COMPOSE_POLL_OPTION_CHANGE = 'COMPOSE_POLL_OPTION_CHANGE';
export const COMPOSE_POLL_OPTION_REMOVE = 'COMPOSE_POLL_OPTION_REMOVE';
export const COMPOSE_POLL_SETTINGS_CHANGE = 'COMPOSE_POLL_SETTINGS_CHANGE';

export const INIT_MEDIA_EDIT_MODAL = 'INIT_MEDIA_EDIT_MODAL';

export const COMPOSE_CHANGE_MEDIA_DESCRIPTION =
  'COMPOSE_CHANGE_MEDIA_DESCRIPTION';
export const COMPOSE_CHANGE_MEDIA_FOCUS = 'COMPOSE_CHANGE_MEDIA_FOCUS';
export const COMPOSE_CHANGE_MEDIA_ORDER = 'COMPOSE_CHANGE_MEDIA_ORDER';

export const COMPOSE_SET_STATUS = 'COMPOSE_SET_STATUS';
export const COMPOSE_FOCUS = 'COMPOSE_FOCUS';

const messages = defineMessages({
  uploadErrorLimit: {
    id: 'upload_error.limit',
    defaultMessage: 'File upload limit exceeded.',
  },
  uploadErrorPoll: {
    id: 'upload_error.poll',
    defaultMessage: 'File upload not allowed with polls.',
  },
  uploadQuote: {
    id: 'upload_error.quote',
    defaultMessage: 'File upload not allowed with quotes.',
  },
  open: { id: 'compose.published.open', defaultMessage: 'Open' },
  published: {
    id: 'compose.published.body',
    defaultMessage: 'Post published.',
  },
  saved: { id: 'compose.saved.body', defaultMessage: 'Post saved.' },
  blankPostError: {
    id: 'compose.error.blank_post',
    defaultMessage: "Post can't be blank.",
  },
});

type LegacyEmoji = NonNullable<
  Awaited<ReturnType<typeof emojiMartSearch>>
>[number];

/** A suggestion of the compose form's autocomplete, as the reducer lists it. */
export type ComposeSuggestion =
  | (LegacyEmoji & { type: 'emoji' })
  | (ApiHashtagJSON & { type: 'hashtag' })
  | { type: 'account'; id: string };

/** Where a suggestion goes: `['text']`, `['spoiler_text']`, `['poll', 'options', index]`. */
type ComposeSuggestionPath = (string | number)[];

// The compose state is an untyped Immutable map (`reducers/compose.js`):
// its values are read through these guards.
const stringOf = (value: unknown) => (typeof value === 'string' ? value : null);

const composeValue = (state: RootState, key: string): unknown =>
  state.compose.get(key);

const composeString = (state: RootState, key: string) =>
  stringOf(composeValue(state, key));

/** The `poll` of the compose state (an Immutable map), as the API takes it. */
const composePoll = (poll: unknown): ApiStatusPollParams | null => {
  if (!isMap(poll)) {
    return null;
  }

  const options: unknown = poll.get('options');
  const expiresIn: unknown = poll.get('expires_in');
  const multiple: unknown = poll.get('multiple');

  return {
    options: isList(options)
      ? options.toArray().filter((option) => typeof option === 'string')
      : [],
    ...(typeof expiresIn === 'number' ? { expires_in: expiresIn } : {}),
    ...(typeof multiple === 'boolean' ? { multiple } : {}),
  };
};

/** The attachments of the compose state (Immutable maps). */
const composeMedia = (state: RootState): ImmutableList<unknown> => {
  const media = composeValue(state, 'media_attachments');
  return isList(media) ? media : ImmutableList();
};

/** An attachment's `media_attributes` entry: its alt text and focal point. */
const mediaAttributesOf = (
  item: unknown,
): ApiStatusMediaAttributeParams | null => {
  if (!isMap(item)) {
    return null;
  }

  const id = stringOf(item.get('id'));
  if (id === null) {
    return null;
  }

  const x: unknown = item.getIn(['meta', 'focus', 'x']);
  const y: unknown = item.getIn(['meta', 'focus', 'y']);
  const focus =
    item.getIn(['meta', 'focus']) &&
    typeof x === 'number' &&
    typeof y === 'number'
      ? `${x.toFixed(2)},${y.toFixed(2)}`
      : undefined;

  return {
    id,
    description: stringOf(item.get('description')),
    focus,
  };
};

export const ensureComposeIsVisible = (getState: GetState) => {
  if (!composeValue(getState(), 'mounted')) {
    browserHistory.push('/publish', { focusTarget: false });
  }
};

export function setComposeToStatus(
  status: Status,
  text: string,
  spoiler_text: string,
) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const maxOptions =
      getState().server.server.item?.configuration.polls.max_options;

    dispatch({
      type: COMPOSE_SET_STATUS,
      status,
      text,
      spoiler_text,
      maxOptions,
    });
  };
}

export function changeCompose(text: string) {
  return {
    type: COMPOSE_CHANGE,
    text: text,
  };
}

export function replyCompose(status: Status) {
  return (dispatch: AppDispatch, getState: GetState) => {
    dispatch({
      type: COMPOSE_REPLY,
      status: status,
    });

    ensureComposeIsVisible(getState);
  };
}

export function replyComposeById(statusId: string) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const state = getState();
    const status = state.statuses.get(statusId);

    if (status) {
      const accountId = status.get('account');
      const account =
        typeof accountId === 'string'
          ? state.accounts.get(accountId)
          : undefined;
      dispatch(replyCompose(status.set('account', account)));
    }
  };
}

export function cancelReplyCompose() {
  return {
    type: COMPOSE_REPLY_CANCEL,
  };
}

export function resetCompose() {
  return {
    type: COMPOSE_RESET,
  };
}

export const focusCompose =
  (defaultText = '', caretStart = false) =>
  (dispatch: AppDispatch, getState: GetState) => {
    dispatch({
      type: COMPOSE_FOCUS,
      defaultText,
      caretStart,
    });

    ensureComposeIsVisible(getState);
  };

export function mentionCompose(account: Account) {
  return (dispatch: AppDispatch, getState: GetState) => {
    dispatch({
      type: COMPOSE_MENTION,
      account: account,
    });

    ensureComposeIsVisible(getState);
  };
}

export function mentionComposeById(accountId: string) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const account = getState().accounts.get(accountId);

    if (account) {
      dispatch(mentionCompose(account));
    }
  };
}

export function directCompose(account: Account) {
  return (dispatch: AppDispatch, getState: GetState) => {
    dispatch({
      type: COMPOSE_DIRECT,
      account: account,
    });

    ensureComposeIsVisible(getState);
  };
}

export function submitCompose(
  successCallback?: (status: ApiStatusJSON) => void,
) {
  return function (dispatch: AppDispatch, getState: GetState) {
    const state = getState();
    const statusText = composeString(state, 'text');
    const media = composeMedia(state);
    const statusId = composeString(state, 'id');
    const quotedStatusId = composeString(state, 'quoted_status_id');
    const hasQuote = !!quotedStatusId;
    const spoiler_text = composeValue(state, 'spoiler')
      ? (composeString(state, 'spoiler_text') ?? '')
      : '';

    const fulltext = `${spoiler_text}${countableText(statusText ?? '')}`;
    const hasText = fulltext.trim().length > 0;

    if (!(hasText || media.size !== 0 || (hasQuote && spoiler_text.length))) {
      dispatch(
        showAlert({
          message: messages.blankPostError,
        }),
      );
      dispatch(focusCompose());

      return;
    }

    dispatch(submitComposeRequest());

    // If we're editing a post with media attachments, those have not
    // necessarily been changed on the server. Do it now in the same
    // API call.
    const media_attributes =
      statusId !== null
        ? media
            .toArray()
            .map(mediaAttributesOf)
            .filter((attributes) => attributes !== null)
        : undefined;

    const visibility = composeString(state, 'privacy');
    const sensitive = composeValue(state, 'sensitive');
    const params = {
      status: statusText ?? undefined,
      spoiler_text,
      in_reply_to_id: composeString(state, 'in_reply_to'),
      media_ids: media
        .toArray()
        .map((item) => (isMap(item) ? stringOf(item.get('id')) : null))
        .filter((id) => id !== null),
      media_attributes,
      sensitive: typeof sensitive === 'boolean' ? sensitive : undefined,
      visibility: visibility ?? undefined,
      poll: composePoll(composeValue(state, 'poll')),
      language: composeString(state, 'language'),
      quoted_status_id: quotedStatusId,
      quote_approval_policy:
        visibility === 'private' || visibility === 'direct'
          ? 'nobody'
          : (composeString(state, 'quote_policy') ?? undefined),
    } satisfies ApiCreateStatusParams;

    const idempotencyKey = composeString(state, 'idempotencyKey');

    apiSubmitStatus({ statusId, params, idempotencyKey })
      .then(function (status) {
        if (
          (browserHistory.location.pathname === '/publish' ||
            browserHistory.location.pathname === '/statuses/new') &&
          window.history.state
        ) {
          browserHistory.goBack();
        }

        dispatch(insertIntoTagHistory(status.tags, statusText ?? ''));
        dispatch(submitComposeSuccess({ ...status }));
        if (typeof successCallback === 'function') {
          successCallback(status);
        }

        // To make the app more responsive, immediately push the status
        // into the columns
        const insertIfOnline = (timelineId: string) => {
          const timeline = getState().timelines.get(timelineId);
          const items: unknown = timeline?.get('items');

          if (
            timeline &&
            isList(items) &&
            items.size > 0 &&
            items.get(0) !== null &&
            timeline.get('online')
          ) {
            dispatch(updateTimeline(timelineId, { ...status }));
          }
        };

        if (statusId) {
          dispatch(importFetchedStatus({ ...status }));
        }

        if (statusId === null && status.visibility !== 'direct') {
          insertIfOnline('home');
        }

        if (
          statusId === null &&
          status.in_reply_to_id === null &&
          status.visibility === 'public'
        ) {
          insertIfOnline('community');
          insertIfOnline('public');
          insertIfOnline(`account:${status.account.id}`);
        }

        dispatch(insertStatusIntoAccountTimelines({ ...status }));

        dispatch(
          showAlert({
            message: statusId === null ? messages.published : messages.saved,
            action: messages.open,
            onClick: () => {
              browserHistory.push(`/@${status.account.username}/${status.id}`, {
                focusTarget: 'detailed-status',
              });
            },
          }),
        );
      })
      .catch(function (error: unknown) {
        dispatch(submitComposeFail(error));
      });
  };
}

export function submitComposeRequest() {
  return {
    type: COMPOSE_SUBMIT_REQUEST,
  };
}

export function submitComposeSuccess(status: ApiStatusJSON) {
  return {
    type: COMPOSE_SUBMIT_SUCCESS,
    status: status,
  };
}

export function submitComposeFail(error: unknown) {
  return {
    type: COMPOSE_SUBMIT_FAIL,
    error: error,
  };
}

export function uploadCompose(files: FileList | File[]) {
  return function (dispatch: AppDispatch, getState: GetState) {
    const state = getState();
    // Exit if there's a quote.
    if (composeValue(state, 'quoted_status_id')) {
      dispatch(showAlert({ message: messages.uploadQuote }));
      return;
    }
    const uploadLimit =
      state.server.server.item?.configuration.statuses.max_media_attachments ??
      Infinity;
    const media = composeMedia(state);
    const pendingValue = composeValue(state, 'pending_media_attachments');
    const pending = typeof pendingValue === 'number' ? pendingValue : 0;
    const progress = new Array<number>(files.length).fill(0);

    const total = Array.from(files).reduce((a, v) => a + v.size, 0);

    if (files.length + media.size + pending > uploadLimit) {
      dispatch(showAlert({ message: messages.uploadErrorLimit }));
      return;
    }

    dispatch(uploadComposeRequest());

    for (const [i, file] of Array.from(files).entries()) {
      if (media.size + i > uploadLimit - 1) break;

      apiUploadMedia({ file }, ({ loaded }) => {
        progress[i] = loaded;
        dispatch(
          uploadComposeProgress(
            progress.reduce((a, v) => a + v, 0),
            total,
          ),
        );
      })
        .then(({ status, data }) => {
          // If server-side processing of the media attachment has not completed yet,
          // poll the server until it is, before showing the media attachment as uploaded

          if (status === 200) {
            dispatch(uploadComposeSuccess(data, file));
          } else if (status === 202) {
            dispatch(uploadComposeProcessing());

            let tryCount = 1;

            const poll = () => {
              apiGetMedia(data.id)
                .then((response) => {
                  if (response.status === 200) {
                    dispatch(uploadComposeSuccess(response.data, file));
                  } else if (response.status === 206) {
                    const retryAfter = (Math.log2(tryCount) || 1) * 1000;
                    tryCount += 1;
                    setTimeout(() => {
                      poll();
                    }, retryAfter);
                  }
                })
                .catch((error: unknown) => dispatch(uploadComposeFail(error)));
            };

            poll();
          }
        })
        .catch((error: unknown) => dispatch(uploadComposeFail(error)));
    }
  };
}

export const uploadComposeProcessing = () => ({
  type: COMPOSE_UPLOAD_PROCESSING,
});

export const uploadThumbnail =
  (id: string, file: File) => (dispatch: AppDispatch) => {
    dispatch(uploadThumbnailRequest());

    const total = file.size;

    apiUploadMediaThumbnail(id, { thumbnail: file }, ({ loaded }) => {
      dispatch(uploadThumbnailProgress(loaded, total));
    })
      .then((media) => {
        dispatch(uploadThumbnailSuccess(media));
      })
      .catch((error: unknown) => {
        dispatch(uploadThumbnailFail(error));
      });
  };

export const uploadThumbnailRequest = () => ({
  type: THUMBNAIL_UPLOAD_REQUEST,
  skipLoading: true,
});

export const uploadThumbnailProgress = (loaded: number, total: number) => ({
  type: THUMBNAIL_UPLOAD_PROGRESS,
  loaded,
  total,
  skipLoading: true,
});

export const uploadThumbnailSuccess = (media: ApiMediaAttachmentJSON) => ({
  type: THUMBNAIL_UPLOAD_SUCCESS,
  media,
  skipLoading: true,
});

export const uploadThumbnailFail = (error: unknown) => ({
  type: THUMBNAIL_UPLOAD_FAIL,
  error,
  skipLoading: true,
});

export function initMediaEditModal(id: string) {
  return (dispatch: AppDispatch) => {
    dispatch({
      type: INIT_MEDIA_EDIT_MODAL,
      id,
    });

    dispatch(
      openModal({
        modalType: 'FOCAL_POINT',
        modalProps: { mediaId: id },
      }),
    );
  };
}

export function onChangeMediaDescription(description: string) {
  return {
    type: COMPOSE_CHANGE_MEDIA_DESCRIPTION,
    description,
  };
}

export function onChangeMediaFocus(focusX: number, focusY: number) {
  return {
    type: COMPOSE_CHANGE_MEDIA_FOCUS,
    focusX,
    focusY,
  };
}

export function uploadComposeRequest() {
  return {
    type: COMPOSE_UPLOAD_REQUEST,
    skipLoading: true,
  };
}

export function uploadComposeProgress(loaded: number, total: number) {
  return {
    type: COMPOSE_UPLOAD_PROGRESS,
    loaded: loaded,
    total: total,
  };
}

export function uploadComposeSuccess(
  media: ApiMediaAttachmentJSON,
  file: File,
) {
  return {
    type: COMPOSE_UPLOAD_SUCCESS,
    media: media,
    file: file,
    skipLoading: true,
  };
}

export function uploadComposeFail(error: unknown) {
  return {
    type: COMPOSE_UPLOAD_FAIL,
    error: error,
    skipLoading: true,
  };
}

export function undoUploadCompose(media_id: string) {
  return {
    type: COMPOSE_UPLOAD_UNDO,
    media_id: media_id,
  };
}

export function clearComposeSuggestions() {
  fetchComposeSuggestionsAccountsController?.abort();
  searchComposeSuggestionsEmojiController?.abort();
  return {
    type: COMPOSE_SUGGESTIONS_CLEAR,
  };
}

const fetchComposeSuggestionsAccounts = throttle(
  (dispatch: AppDispatch, token: string) => {
    if (fetchComposeSuggestionsAccountsController) {
      fetchComposeSuggestionsAccountsController.abort();
    }

    fetchComposeSuggestionsAccountsController = new AbortController();

    apiSearchAccounts(
      {
        q: token.slice(1),
        resolve: false,
        limit: 4,
      },
      { signal: fetchComposeSuggestionsAccountsController.signal },
    )
      .then((accounts) => {
        dispatch(importFetchedAccounts(accounts));
        dispatch(readyComposeSuggestionsAccounts(token, accounts));
      })
      .catch((error: unknown) => {
        if (!isCancel(error)) {
          dispatch(showAlertForError(error));
        }
      })
      .finally(() => {
        fetchComposeSuggestionsAccountsController = undefined;
      });
  },
  200,
  { leading: true, trailing: true },
);

const fetchComposeSuggestionsEmojis = (
  dispatch: AppDispatch,
  token: string,
) => {
  dispatch(clearComposeSuggestions());
  searchComposeSuggestionsEmojiController = new AbortController();

  void emojiMartSearch({
    token,
    // Right now we are hard-coding the locale to English since the picker search only supports English.
    // Once we replace the legacy picker we can remove this and use the actual locale of the user.
    locale: 'en',
    limit: 5,
    signal: searchComposeSuggestionsEmojiController.signal,
  })
    .then((results) => {
      if (results) {
        dispatch(readyComposeSuggestionsEmojis(token, results));
      }
    })
    .finally(() => {
      searchComposeSuggestionsEmojiController = undefined;
    });
};

const fetchComposeSuggestionsTags = throttle(
  (dispatch: AppDispatch, token: string) => {
    if (fetchComposeSuggestionsTagsController) {
      fetchComposeSuggestionsTagsController.abort();
    }

    dispatch(updateSuggestionTags(token));

    fetchComposeSuggestionsTagsController = new AbortController();

    apiGetSearch(
      {
        type: 'hashtags',
        q: token.slice(1),
        resolve: false,
        limit: 4,
        exclude_unreviewed: true,
      },
      { signal: fetchComposeSuggestionsTagsController.signal },
    )
      .then((data) => {
        dispatch(readyComposeSuggestionsTags(token, data.hashtags));
      })
      .catch((error: unknown) => {
        if (!isCancel(error)) {
          dispatch(showAlertForError(error));
        }
      })
      .finally(() => {
        fetchComposeSuggestionsTagsController = undefined;
      });
  },
  200,
  { leading: true, trailing: true },
);

export function fetchComposeSuggestions(token: string) {
  return (dispatch: AppDispatch) => {
    switch (token[0]) {
      case ':':
        fetchComposeSuggestionsEmojis(dispatch, token);
        break;
      case '#':
      case '＃':
        fetchComposeSuggestionsTags(dispatch, token);
        break;
      default:
        fetchComposeSuggestionsAccounts(dispatch, token);
        break;
    }
  };
}

export function readyComposeSuggestionsEmojis(
  token: string,
  emojis: LegacyEmoji[],
) {
  return {
    type: COMPOSE_SUGGESTIONS_READY,
    token,
    emojis,
  };
}

export function readyComposeSuggestionsAccounts(
  token: string,
  accounts: ApiAccountJSON[],
) {
  return {
    type: COMPOSE_SUGGESTIONS_READY,
    token,
    accounts,
  };
}

export const readyComposeSuggestionsTags = (
  token: string,
  tags: ApiHashtagJSON[],
) => ({
  type: COMPOSE_SUGGESTIONS_READY,
  token,
  tags,
});

export function selectComposeSuggestion(
  position: number,
  token: string,
  suggestion: ComposeSuggestion,
  path: ComposeSuggestionPath,
) {
  return (dispatch: AppDispatch, getState: GetState) => {
    let completion: string | undefined, startPosition: number | undefined;

    if (suggestion.type === 'emoji') {
      completion =
        ('native' in suggestion ? suggestion.native : undefined) ||
        `:${suggestion.id}:`;
      startPosition = position - 1;

      dispatch(useEmoji(suggestion));
    } else if (suggestion.type === 'hashtag') {
      // TODO: it could make sense to keep the “most capitalized” of the two
      const tokenName = token.slice(1); // strip leading '#'
      const suggestionPrefix = suggestion.name.slice(0, tokenName.length);
      const prefixMatchesSuggestion =
        suggestionPrefix.localeCompare(tokenName, undefined, {
          sensitivity: 'accent',
        }) === 0;
      if (prefixMatchesSuggestion) {
        completion = token + suggestion.name.slice(tokenName.length);
      } else {
        completion = `${token.slice(0, 1)}${suggestion.name}`;
      }

      startPosition = position - 1;
    } else {
      completion = `@${getState().accounts.get(suggestion.id)?.get('acct')}`;
      startPosition = position - 1;
    }

    // We don't want to replace hashtags that vary only in case due to accessibility, but we need to fire off an event so that
    // the suggestions are dismissed and the cursor moves forward.
    if (
      suggestion.type !== 'hashtag' ||
      token.slice(1).localeCompare(suggestion.name, undefined, {
        sensitivity: 'accent',
      }) !== 0
    ) {
      dispatch({
        type: COMPOSE_SUGGESTION_SELECT,
        position: startPosition,
        token,
        completion,
        path,
      });
    } else {
      dispatch({
        type: COMPOSE_SUGGESTION_IGNORE,
        position: startPosition,
        token,
        completion,
        path,
      });
    }
  };
}

export function updateSuggestionTags(token: string) {
  return {
    type: COMPOSE_SUGGESTION_TAGS_UPDATE,
    token,
  };
}

export function updateTagHistory(tags: string[]) {
  return {
    type: COMPOSE_TAG_HISTORY_UPDATE,
    tags,
  };
}

export function hydrateCompose() {
  return (dispatch: AppDispatch, getState: GetState) => {
    const me = stringOf(getState().meta.get('me'));
    const history = me === null ? null : tagHistory.get(me);

    if (history !== null && history !== undefined) {
      dispatch(updateTagHistory(history));
    }
  };
}

function insertIntoTagHistory(recognizedTags: ApiTagJSON[], text: string) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const state = getState();
    const oldHistoryValue = composeValue(state, 'tagHistory');
    const oldHistory = isList(oldHistoryValue)
      ? oldHistoryValue.toArray().filter((name) => typeof name === 'string')
      : [];
    const me = stringOf(state.meta.get('me'));

    // FIXME: Matching input hashtags with recognized hashtags has become more
    // complicated because of new normalization rules, it's no longer just
    // a case sensitivity issue
    const names = recognizedTags.map((tag) => {
      const matches = text.match(new RegExp(`[#＃]${tag.name}`, 'i'));

      if (matches && matches.length > 0) {
        return matches[0].slice(1);
      } else {
        return tag.name;
      }
    });

    const intersectedOldHistory = oldHistory.filter(
      (name) =>
        names.findIndex(
          (newName) => newName.toLowerCase() === name.toLowerCase(),
        ) === -1,
    );

    names.push(...intersectedOldHistory);

    const newHistory = names.slice(0, 1000);

    if (me !== null) {
      tagHistory.set(me, newHistory);
    }
    dispatch(updateTagHistory(newHistory));
  };
}

export function mountCompose() {
  return {
    type: COMPOSE_MOUNT,
  };
}

export function unmountCompose() {
  return {
    type: COMPOSE_UNMOUNT,
  };
}

export function changeComposeSensitivity() {
  return {
    type: COMPOSE_SENSITIVITY_CHANGE,
  };
}

export const changeComposeLanguage = (language: string) => ({
  type: COMPOSE_LANGUAGE_CHANGE,
  language,
});

export function changeComposeSpoilerness() {
  return {
    type: COMPOSE_SPOILERNESS_CHANGE,
  };
}

export function changeComposeSpoilerText(text: string) {
  return {
    type: COMPOSE_SPOILER_TEXT_CHANGE,
    text,
  };
}

export function insertEmojiCompose(
  position: number,
  emoji: { native: string },
  needsSpace: boolean,
) {
  return {
    type: COMPOSE_EMOJI_INSERT,
    position,
    emoji,
    needsSpace,
  };
}

export function changeComposing(value: boolean) {
  return {
    type: COMPOSE_COMPOSING_CHANGE,
    value,
  };
}

export function addPoll() {
  return {
    type: COMPOSE_POLL_ADD,
  };
}

export function removePoll() {
  return {
    type: COMPOSE_POLL_REMOVE,
  };
}

export function addPollOption(title: string) {
  return {
    type: COMPOSE_POLL_OPTION_ADD,
    title,
  };
}

export function changePollOption(
  index: number,
  title: string,
  maxOptions: number,
) {
  return {
    type: COMPOSE_POLL_OPTION_CHANGE,
    index,
    title,
    maxOptions,
  };
}

export function removePollOption(index: number) {
  return {
    type: COMPOSE_POLL_OPTION_REMOVE,
    index,
  };
}

export function changePollSettings(expiresIn: number, isMultiple: boolean) {
  return {
    type: COMPOSE_POLL_SETTINGS_CHANGE,
    expiresIn,
    isMultiple,
  };
}

export const changeMediaOrder = (a: string, b: string) => ({
  type: COMPOSE_CHANGE_MEDIA_ORDER,
  a,
  b,
});
