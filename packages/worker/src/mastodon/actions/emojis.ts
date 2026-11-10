import type { AppDispatch } from 'mastodon/store';

import { saveSettings } from './settings';

export const EMOJI_USE = 'EMOJI_USE';

/** An emoji the picker or an autosuggestion used (counted by its `id`). */
interface UsedEmoji {
  id: string;
}

export function useEmoji(emoji: UsedEmoji) {
  return (dispatch: AppDispatch) => {
    dispatch({
      type: EMOJI_USE,
      emoji,
    });

    dispatch(saveSettings());
  };
}
