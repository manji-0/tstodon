import type {
  ApiInitialStateJSON,
  ApiInitialStateLanguageJSON,
  ApiInitialStateMetaJSON,
} from '@tstodon/api';

// The initial state's shape is shared with the server, which renders it
// (`@tstodon/api`, `packages/api/src/initial-state.ts`).
type InitialStateLanguage = ApiInitialStateLanguageJSON;
type InitialStateMeta = ApiInitialStateMetaJSON;

export type InitialState = ApiInitialStateJSON;

const element = document.getElementById('initial-state');
export const initialState: InitialState | undefined = element?.textContent
  ? (JSON.parse(element.textContent) as InitialState)
  : undefined;

const initialPath: string =
  document
    .querySelector('head meta[name=initialPath]')
    ?.getAttribute('content') ?? '';
export const hasMultiColumnPath: boolean =
  initialPath === '/' ||
  initialPath === '/getting-started' ||
  initialPath === '/home' ||
  initialPath.startsWith('/deck');

function getMeta<K extends keyof InitialStateMeta>(
  prop: K,
): InitialStateMeta[K] | undefined {
  return initialState?.meta[prop];
}

export const activityApiEnabled = getMeta('activity_api_enabled');
export const autoPlayGif = getMeta('auto_play_gif');
export const boostModal = getMeta('boost_modal');
export const quickBoosting = getMeta('quick_boosting');
export const deleteModal = getMeta('delete_modal');
export const missingAltTextModal = getMeta('missing_alt_text_modal');
export const disableSwiping = getMeta('disable_swiping');
export const disableHoverCards = getMeta('disable_hover_cards');
export const disabledAccountId = getMeta('disabled_account_id');
export const displayMedia = getMeta('display_media');
export const domain = getMeta('domain');
export const emojiStyle = getMeta('emoji_style') ?? 'auto';
export const expandSpoilers = getMeta('expand_spoilers');
export const forceSingleColumn = !getMeta('advanced_layout');
export const limitedFederationMode = getMeta('limited_federation_mode');
export const mascot = getMeta('mascot');
export const me = getMeta('me');
export const movedToAccountId = getMeta('moved_to_account_id');
export const owner = getMeta('owner');
export const profile_directory = getMeta('profile_directory');
export const reduceMotion = getMeta('reduce_motion');
export const registrationsOpen = getMeta('registrations_open');
export const repository = getMeta('repository');
export const searchEnabled = getMeta('search_enabled');
export const trendsEnabled = getMeta('trends_enabled');
export const showTrends = getMeta('show_trends');
export const singleUserMode = getMeta('single_user_mode');
export const source_url = getMeta('source_url');
export const localLiveFeedAccess = getMeta('local_live_feed_access');
export const remoteLiveFeedAccess = getMeta('remote_live_feed_access');
export const localTopicFeedAccess = getMeta('local_topic_feed_access');
export const remoteTopicFeedAccess = getMeta('remote_topic_feed_access');
export const title = getMeta('title');
export const landingPage = getMeta('landing_page');
export const useBlurhash = getMeta('use_blurhash');
export const usePendingItems = getMeta('use_pending_items');
export const version = getMeta('version');
export const criticalUpdatesPending = initialState?.critical_updates_pending;
export const statusPageUrl = getMeta('status_page_url');
export const sso_redirect = getMeta('sso_redirect');
export const termsOfServiceEnabled = getMeta('terms_of_service_enabled');
export const wrapstodon = getMeta('wrapstodon');

const displayNames =
  // Intl.DisplayNames can be undefined in old browsers
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  Intl.DisplayNames &&
  (new Intl.DisplayNames(getMeta('locale'), {
    type: 'language',
    fallback: 'none',
    languageDisplay: 'standard',
  }) as Intl.DisplayNames | undefined);

export const languages = initialState?.languages.map((lang) => {
  // zh-YUE is not a valid CLDR unicode_language_id
  return [
    lang[0],
    displayNames?.of(lang[0].replace('zh-YUE', 'yue')) ?? lang[1],
    lang[2],
  ] as InitialStateLanguage;
});

export function getAccessToken(): string | undefined {
  return getMeta('access_token') ?? undefined;
}
