import { useCallback, useEffect } from 'react';

import { changeSetting } from '@/mastodon/actions/settings';
import { bannerSettings } from '@/mastodon/settings';
import { useAppSelector, useAppDispatch } from '@/mastodon/store';

export function useDismissible(id: string) {
  // We use "dismissed_banners" as that was what this was previously called,
  // but we can use this to track any dismissible state.
  const dismissed = useAppSelector(
    (state) => !!state.settings.get('dismissed_banners').get(id, false),
  );

  const wasDismissed = !!bannerSettings.get(id) || dismissed;

  const dispatch = useAppDispatch();

  const dismiss = useCallback(() => {
    bannerSettings.set(id, true);
    dispatch(changeSetting(['dismissed_banners', id], true));
  }, [id, dispatch]);

  useEffect(() => {
    // Store legacy localStorage setting on server
    if (wasDismissed && !dismissed) {
      dispatch(changeSetting(['dismissed_banners', id], true));
    }
  }, [id, dispatch, wasDismissed, dismissed]);

  return {
    wasDismissed,
    dismiss,
  };
}
