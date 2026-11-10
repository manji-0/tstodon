import type { AppDispatch } from 'mastodon/store';

import { changeSetting, saveSettings } from './settings';

export const INTRODUCTION_VERSION = 20181216044202;

export const closeOnboarding = () => (dispatch: AppDispatch) => {
  dispatch(changeSetting(['introductionVersion'], INTRODUCTION_VERSION));
  dispatch(saveSettings());
};
