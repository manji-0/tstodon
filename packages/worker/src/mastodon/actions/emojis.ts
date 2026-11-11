import type { AppDispatch } from 'mastodon/store';

import { saveSettings } from './settings';

export const EMOJI_USE = 'EMOJI_USE' as const;

/** An emoji the picker or an autosuggestion used (counted by its `id`). */
interface UsedEmoji {
  id: string;
}

export type EmojiUseAction = {
  type: typeof EMOJI_USE;
  emoji: UsedEmoji;
};

export function useEmoji(emoji: UsedEmoji) {
  return (dispatch: AppDispatch) => {
    dispatch({
      type: EMOJI_USE,
      emoji,
    } satisfies EmojiUseAction);

    dispatch(saveSettings());
  };
}
