import type { PropsWithChildren } from 'react';
import type React from 'react';

import type { HistoryRouterProps, Location, Path, To } from 'react-router';
import {
  parsePath,
  unstable_HistoryRouter as HistoryRouter,
  UNSAFE_createBrowserHistory as createBrowserHistory,
} from 'react-router';

import { forceSingleColumn, hasMultiColumnPath } from '../initial_state';

import type { FocusTarget } from './navigation_focus_target';

interface MastodonLocationState {
  fromMastodon?: boolean;
  mastodonModalKey?: string;
  // Controls which element is focused after a navigation.
  // Set to `false` to prevent navigation focus.
  focusTarget?: FocusTarget;
  // Prevent the rightmost column in advanced UI from scrolling
  // into view on location changes
  preventMultiColumnAutoScroll?: string;
}

export type LocationState = MastodonLocationState | null | undefined;

export type MastodonLocation = Location<LocationState>;

export type MastodonLocationDescriptor = To;

type History = HistoryRouterProps['history'];
type HistoryListener = Parameters<History['listen']>[0];

// `v5Compat` notifies the listener of pushes and replaces, not only of pops,
// as react-router's own `<BrowserRouter>` needs.
export const browserHistory = createBrowserHistory({ v5Compat: true });
const originalPush = browserHistory.push.bind(browserHistory);
const originalReplace = browserHistory.replace.bind(browserHistory);

// react-router's history takes a single listener; the router, the scroll
// restoration and the modals each listen.
const listeners = new Set<HistoryListener>();
browserHistory.listen((update) => {
  listeners.forEach((listener) => {
    listener(update);
  });
});
browserHistory.listen = (listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function normalizePath(path: To): Partial<Path> {
  const location = typeof path === 'string' ? parsePath(path) : { ...path };

  if (
    !forceSingleColumn &&
    hasMultiColumnPath &&
    location.pathname &&
    !location.pathname.startsWith('/deck')
  ) {
    location.pathname = `/deck${location.pathname}`;
  }

  return location;
}

browserHistory.push = (path: To, state?: LocationState) => {
  const location = normalizePath(path);

  originalPush(location, { ...state, fromMastodon: true });
};

browserHistory.replace = (path: To, state?: LocationState) => {
  const location = normalizePath(path);

  if (!location.pathname) return;

  const currentState: LocationState = browserHistory.location.state;

  originalReplace(
    location,
    currentState?.fromMastodon ? { ...state, fromMastodon: true } : state,
  );
};

export const Router: React.FC<PropsWithChildren> = ({ children }) => {
  // No transitions: a navigation renders right away, as with react-router 5.
  return (
    <HistoryRouter history={browserHistory} useTransitions={false}>
      {children}
    </HistoryRouter>
  );
};
