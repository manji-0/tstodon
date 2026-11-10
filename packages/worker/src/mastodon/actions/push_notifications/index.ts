import type { AppDispatch } from 'mastodon/store';

import { saveSettings } from './registerer';
import { setAlerts } from './setter';

export function changeAlerts(path: readonly string[], value: unknown) {
  return (dispatch: AppDispatch) => {
    dispatch(setAlerts(path, value));
    dispatch(saveSettings());
  };
}

export {
  CLEAR_SUBSCRIPTION,
  SET_BROWSER_SUPPORT,
  SET_SUBSCRIPTION,
  SET_ALERTS,
} from './setter';
export { register } from './registerer';
