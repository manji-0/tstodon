// The types of `index.js`, which stays JavaScript (as upstream has it), for
// its TypeScript importers. Keep them in step with it.
import type { Map as ImmutableMap } from 'immutable';

import type { ExpandedStatus } from 'mastodon/models/status';
import type { RootState } from 'mastodon/store';
import type { ImmutableMapOf } from 'mastodon/utils/immutable_map_of';

export { makeGetAccount } from './accounts';
export { getStatusList } from './statuses';

interface GetStatusProps {
  id?: string | null;
  contextType?: string;
}

/** Why `makeGetStatusWithExtraInfo` gave no status, or `complete`. */
export type StatusLoadingState =
  | 'not-found'
  | 'loading'
  | 'filtered'
  | 'complete';

/**
 * The status with its account and boosted status, or `null` when it is not
 * in the store, is a stub being fetched, or is hidden by a filter.
 */
export function makeGetStatus(): (
  state: RootState,
  props: GetStatusProps,
) => ExpandedStatus | null;

export function makeGetStatusWithExtraInfo(): (
  state: RootState,
  props: GetStatusProps,
) => { status: ExpandedStatus | null; loadingState: StatusLoadingState };

export function makeGetPictureInPicture(): (
  state: RootState,
  props: { id: string },
) => ImmutableMapOf<{ inUse: boolean; available: boolean }>;

export function makeGetNotification(): (
  state: RootState,
  base: ImmutableMap<string, unknown>,
  accountId: string,
) => ImmutableMap<string, unknown>;

export function makeGetReport(): (
  state: RootState,
  base: ImmutableMap<string, unknown>,
  targetAccountId: string,
) => ImmutableMap<string, unknown>;
