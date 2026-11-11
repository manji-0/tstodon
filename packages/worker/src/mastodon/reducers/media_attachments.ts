import type { Reducer } from '@reduxjs/toolkit';
import { List as ImmutableList, isList, isMap } from 'immutable';

import { STORE_HYDRATE } from '../actions/store';
import { immutableMapOf } from '../utils/immutable_map_of';

type MediaAttachmentsFields = {
  /** The MIME types and extensions the server takes for uploads. */
  accept_content_types: ImmutableList<string>;
};

const initialState = immutableMapOf<MediaAttachmentsFields>({
  accept_content_types: ImmutableList(),
});
type State = typeof initialState;

const isStringList = (value: unknown): value is ImmutableList<string> =>
  isList(value) && value.every((item) => typeof item === 'string');

/** The initial state's `media_attachments`, as `hydrateStore` converted it. */
const hydratedFields = (
  hydrated: unknown,
): Partial<MediaAttachmentsFields> | null => {
  const mediaAttachments: unknown = isMap(hydrated)
    ? hydrated.get('media_attachments')
    : undefined;
  if (!isMap(mediaAttachments)) {
    return null;
  }

  const acceptContentTypes = mediaAttachments.get('accept_content_types');
  return isStringList(acceptContentTypes)
    ? { accept_content_types: acceptContentTypes }
    : {};
};

export const mediaAttachmentsReducer: Reducer<State> = (
  state = initialState,
  action,
) => {
  if (action.type === STORE_HYDRATE) {
    const fields = hydratedFields(action.state);
    return fields ? state.merge(fields) : state;
  }

  return state;
};

export default mediaAttachmentsReducer;
