import { createReducer } from '@reduxjs/toolkit';
import { Map as ImmutableMap, List as ImmutableList } from 'immutable';

import type { ApiFeaturedTagJSON } from '@tstodon/api';
import { expandDirectory, fetchDirectory } from 'mastodon/actions/directory';
import { fetchFeaturedTags } from 'mastodon/actions/featured_tags';
import type { ApiNotificationJSON } from 'mastodon/api_types/notifications';

import {
  FOLLOWERS_FETCH_REQUEST,
  FOLLOWERS_FETCH_SUCCESS,
  FOLLOWERS_FETCH_FAIL,
  FOLLOWERS_EXPAND_REQUEST,
  FOLLOWERS_EXPAND_SUCCESS,
  FOLLOWERS_EXPAND_FAIL,
  FOLLOWING_FETCH_REQUEST,
  FOLLOWING_FETCH_SUCCESS,
  FOLLOWING_FETCH_FAIL,
  FOLLOWING_EXPAND_REQUEST,
  FOLLOWING_EXPAND_SUCCESS,
  FOLLOWING_EXPAND_FAIL,
  FOLLOW_REQUESTS_FETCH_REQUEST,
  FOLLOW_REQUESTS_FETCH_SUCCESS,
  FOLLOW_REQUESTS_FETCH_FAIL,
  FOLLOW_REQUESTS_EXPAND_REQUEST,
  FOLLOW_REQUESTS_EXPAND_SUCCESS,
  FOLLOW_REQUESTS_EXPAND_FAIL,
  authorizeFollowRequestSuccess,
  rejectFollowRequestSuccess,
  fetchEndorsedAccounts,
} from '../actions/accounts';
import type {
  expandFollowersFail,
  expandFollowersRequest,
  expandFollowersSuccess,
  expandFollowingFail,
  expandFollowingRequest,
  expandFollowingSuccess,
  expandFollowRequestsSuccess,
  fetchFollowersFail,
  fetchFollowersRequest,
  fetchFollowersSuccess,
  fetchFollowingFail,
  fetchFollowingRequest,
  fetchFollowingSuccess,
  fetchFollowRequestsSuccess,
} from '../actions/accounts';
import {
  BLOCKS_FETCH_REQUEST,
  BLOCKS_FETCH_SUCCESS,
  BLOCKS_FETCH_FAIL,
  BLOCKS_EXPAND_REQUEST,
  BLOCKS_EXPAND_SUCCESS,
  BLOCKS_EXPAND_FAIL,
} from '../actions/blocks';
import type { expandBlocksSuccess, fetchBlocksSuccess } from '../actions/blocks';
import {
  REBLOGS_FETCH_REQUEST,
  REBLOGS_FETCH_SUCCESS,
  REBLOGS_FETCH_FAIL,
  REBLOGS_EXPAND_REQUEST,
  REBLOGS_EXPAND_SUCCESS,
  REBLOGS_EXPAND_FAIL,
  FAVOURITES_FETCH_REQUEST,
  FAVOURITES_FETCH_SUCCESS,
  FAVOURITES_FETCH_FAIL,
  FAVOURITES_EXPAND_REQUEST,
  FAVOURITES_EXPAND_SUCCESS,
  FAVOURITES_EXPAND_FAIL,
} from '../actions/interactions';
import type {
  expandFavouritesFail,
  expandFavouritesRequest,
  expandFavouritesSuccess,
  expandReblogsFail,
  expandReblogsRequest,
  expandReblogsSuccess,
  fetchFavouritesFail,
  fetchFavouritesRequest,
  fetchFavouritesSuccess,
  fetchReblogsFail,
  fetchReblogsRequest,
  fetchReblogsSuccess,
} from '../actions/interactions';
import {
  MUTES_FETCH_REQUEST,
  MUTES_FETCH_SUCCESS,
  MUTES_FETCH_FAIL,
  MUTES_EXPAND_REQUEST,
  MUTES_EXPAND_SUCCESS,
  MUTES_EXPAND_FAIL,
} from '../actions/mutes';
import type { expandMutesSuccess, fetchMutesSuccess } from '../actions/mutes';
import { notificationsUpdate } from '../actions/notifications';
import { immutableFromJS, immutableMapOf } from '../utils/immutable_map_of';
import type { ImmutableMapOf, ImmutableOf } from '../utils/immutable_map_of';

/** A paginated list of accounts, by id. */
export interface UserListShape {
  /**
   * The next page's URL (`null` on the last page). The directory's is `true`
   * while there are more; endorsed accounts have no pages (`undefined`).
   * Missing while the first page loads.
   */
  next?: string | true | null;
  isLoading: boolean;
  /** Missing while the first page loads. */
  items?: ImmutableList<string>;
}

export type UserList = ImmutableMapOf<UserListShape>;

/** A featured tag (`ApiFeaturedTagJSON`) with the account that features it. */
export type FeaturedTag = ImmutableOf<ApiFeaturedTagJSON & { accountId: string }>;

export interface FeaturedTagListShape {
  /** By `statuses_count`, the highest first. Missing while the first load runs. */
  items?: ImmutableList<FeaturedTag>;
  isLoading: boolean;
}

export type FeaturedTagList = ImmutableMapOf<FeaturedTagListShape>;

export interface UserListsShape {
  /** By account id. */
  followers: ImmutableMap<string, UserList>;
  /** By account id. */
  following: ImmutableMap<string, UserList>;
  /** By status id. */
  reblogged_by: ImmutableMap<string, UserList>;
  /** By status id. */
  favourited_by: ImmutableMap<string, UserList>;
  follow_requests: UserList;
  blocks: UserList;
  mutes: UserList;
  /** By account id. */
  featured_tags: ImmutableMap<string, FeaturedTagList>;
  /** By account id; missing until one is loaded. */
  featured_accounts?: ImmutableMap<string, UserList>;
  /** Missing until the directory is loaded. */
  directory?: UserList;
}

type State = ImmutableMapOf<UserListsShape>;

/** The lists kept for each account or status, by its id. */
type ListByIdKey =
  | 'followers'
  | 'following'
  | 'reblogged_by'
  | 'favourited_by'
  | 'featured_accounts';

/** The lists kept once. */
type SingleListKey = 'follow_requests' | 'blocks' | 'mutes' | 'directory';

const initialListState = immutableMapOf<UserListShape>({
  next: null,
  isLoading: false,
  items: ImmutableList(),
});

const initialState: State = immutableMapOf<UserListsShape>({
  // Upstream started these four with `initialListState`'s fields, as if
  // `next`, `isLoading` and `items` were ids.
  followers: ImmutableMap(),
  following: ImmutableMap(),
  reblogged_by: ImmutableMap(),
  favourited_by: ImmutableMap(),
  follow_requests: initialListState,
  blocks: initialListState,
  mutes: initialListState,
  featured_tags: ImmutableMap(),
});

/** The fields of an account list's or tag list's page. */
interface Page {
  accounts: { id: string }[];
  next: string | true | null | undefined;
}

const newList = ({ accounts, next }: Page) =>
  immutableMapOf<UserListShape>({
    next,
    items: ImmutableList(accounts.map((item) => item.id)),
    isLoading: false,
  });

const appendToList = (
  list: UserList | undefined,
  { accounts, next }: Page,
): UserList =>
  (list ?? immutableMapOf<UserListShape>({ isLoading: false }))
    .set('next', next)
    .set('isLoading', false)
    .update('items', (items) =>
      (items ?? ImmutableList<string>()).concat(accounts.map((item) => item.id)),
    );

// Without a list yet, these make one with `isLoading` only, as upstream's
// `setIn` did.
const setLoading = (list: UserList | undefined, isLoading: boolean) =>
  list
    ? list.set('isLoading', isLoading)
    : immutableMapOf<UserListShape>({ isLoading });

const setTagsLoading = (
  list: FeaturedTagList | undefined,
  isLoading: boolean,
) =>
  list
    ? list.set('isLoading', isLoading)
    : immutableMapOf<FeaturedTagListShape>({ isLoading });

const updateListById = (
  state: State,
  key: ListByIdKey,
  id: string,
  updater: (list: UserList | undefined) => UserList,
) =>
  state.update(key, ImmutableMap<string, UserList>(), (lists) =>
    lists.set(id, updater(lists.get(id))),
  );

const updateSingleList = (
  state: State,
  key: SingleListKey,
  updater: (list: UserList | undefined) => UserList,
) => state.set(key, updater(state.get(key)));

const normalizeFollowRequest = (
  state: State,
  notification: ApiNotificationJSON,
) =>
  updateSingleList(state, 'follow_requests', (list = initialListState) =>
    list.update('items', (items = ImmutableList()) =>
      items
        .filterNot((item) => item === notification.account.id)
        .unshift(notification.account.id),
    ),
  );

const removeFollowRequest = (state: State, accountId: string) =>
  updateSingleList(state, 'follow_requests', (list = initialListState) =>
    list.update('items', (items = ImmutableList()) =>
      items.filterNot((item) => item === accountId),
    ),
  );

const normalizeFeaturedTags = (
  state: State,
  accountId: string,
  featuredTags: ApiFeaturedTagJSON[],
) =>
  state.update('featured_tags', (lists) =>
    lists.set(
      accountId,
      immutableMapOf<FeaturedTagListShape>({
        items: ImmutableList(
          featuredTags.map((featuredTag) =>
            immutableFromJS({ ...featuredTag, accountId }),
          ),
        ).sort(
          // `statuses_count` is a string (as upstream's `-` converted it)
          (a, b) =>
            Number(b.get('statuses_count')) - Number(a.get('statuses_count')),
        ),
        isLoading: false,
      }),
    ),
  );

const setFeaturedTagsLoading = (
  state: State,
  accountId: string,
  isLoading: boolean,
) =>
  state.update('featured_tags', (lists) =>
    lists.set(accountId, setTagsLoading(lists.get(accountId), isLoading)),
  );

export default createReducer(initialState, (builder) => {
  builder
    // Followers
    .addCase(
      FOLLOWERS_FETCH_SUCCESS,
      (state, action: ReturnType<typeof fetchFollowersSuccess>) =>
        updateListById(state, 'followers', action.id, () => newList(action)),
    )
    .addCase(
      FOLLOWERS_EXPAND_SUCCESS,
      (state, action: ReturnType<typeof expandFollowersSuccess>) =>
        updateListById(state, 'followers', action.id, (list) =>
          appendToList(list, action),
        ),
    )
    .addCase(
      FOLLOWERS_FETCH_REQUEST,
      (state, action: ReturnType<typeof fetchFollowersRequest>) =>
        updateListById(state, 'followers', action.id, (list) =>
          setLoading(list, true),
        ),
    )
    .addCase(
      FOLLOWERS_EXPAND_REQUEST,
      (state, action: ReturnType<typeof expandFollowersRequest>) =>
        updateListById(state, 'followers', action.id, (list) =>
          setLoading(list, true),
        ),
    )
    .addCase(
      FOLLOWERS_FETCH_FAIL,
      (state, action: ReturnType<typeof fetchFollowersFail>) =>
        updateListById(state, 'followers', action.id, (list) =>
          setLoading(list, false),
        ),
    )
    .addCase(
      FOLLOWERS_EXPAND_FAIL,
      (state, action: ReturnType<typeof expandFollowersFail>) =>
        updateListById(state, 'followers', action.id, (list) =>
          setLoading(list, false),
        ),
    )
    // Following
    .addCase(
      FOLLOWING_FETCH_SUCCESS,
      (state, action: ReturnType<typeof fetchFollowingSuccess>) =>
        updateListById(state, 'following', action.id, () => newList(action)),
    )
    .addCase(
      FOLLOWING_EXPAND_SUCCESS,
      (state, action: ReturnType<typeof expandFollowingSuccess>) =>
        updateListById(state, 'following', action.id, (list) =>
          appendToList(list, action),
        ),
    )
    .addCase(
      FOLLOWING_FETCH_REQUEST,
      (state, action: ReturnType<typeof fetchFollowingRequest>) =>
        updateListById(state, 'following', action.id, (list) =>
          setLoading(list, true),
        ),
    )
    .addCase(
      FOLLOWING_EXPAND_REQUEST,
      (state, action: ReturnType<typeof expandFollowingRequest>) =>
        updateListById(state, 'following', action.id, (list) =>
          setLoading(list, true),
        ),
    )
    .addCase(
      FOLLOWING_FETCH_FAIL,
      (state, action: ReturnType<typeof fetchFollowingFail>) =>
        updateListById(state, 'following', action.id, (list) =>
          setLoading(list, false),
        ),
    )
    .addCase(
      FOLLOWING_EXPAND_FAIL,
      (state, action: ReturnType<typeof expandFollowingFail>) =>
        updateListById(state, 'following', action.id, (list) =>
          setLoading(list, false),
        ),
    )
    // Boosted by
    .addCase(
      REBLOGS_FETCH_SUCCESS,
      (state, action: ReturnType<typeof fetchReblogsSuccess>) =>
        updateListById(state, 'reblogged_by', action.id, () =>
          newList(action),
        ),
    )
    .addCase(
      REBLOGS_EXPAND_SUCCESS,
      (state, action: ReturnType<typeof expandReblogsSuccess>) =>
        updateListById(state, 'reblogged_by', action.id, (list) =>
          appendToList(list, action),
        ),
    )
    .addCase(
      REBLOGS_FETCH_REQUEST,
      (state, action: ReturnType<typeof fetchReblogsRequest>) =>
        updateListById(state, 'reblogged_by', action.id, (list) =>
          setLoading(list, true),
        ),
    )
    .addCase(
      REBLOGS_EXPAND_REQUEST,
      (state, action: ReturnType<typeof expandReblogsRequest>) =>
        updateListById(state, 'reblogged_by', action.id, (list) =>
          setLoading(list, true),
        ),
    )
    .addCase(
      REBLOGS_FETCH_FAIL,
      (state, action: ReturnType<typeof fetchReblogsFail>) =>
        updateListById(state, 'reblogged_by', action.id, (list) =>
          setLoading(list, false),
        ),
    )
    .addCase(
      REBLOGS_EXPAND_FAIL,
      (state, action: ReturnType<typeof expandReblogsFail>) =>
        updateListById(state, 'reblogged_by', action.id, (list) =>
          setLoading(list, false),
        ),
    )
    // Favourited by
    .addCase(
      FAVOURITES_FETCH_SUCCESS,
      (state, action: ReturnType<typeof fetchFavouritesSuccess>) =>
        updateListById(state, 'favourited_by', action.id, () =>
          newList(action),
        ),
    )
    .addCase(
      FAVOURITES_EXPAND_SUCCESS,
      (state, action: ReturnType<typeof expandFavouritesSuccess>) =>
        updateListById(state, 'favourited_by', action.id, (list) =>
          appendToList(list, action),
        ),
    )
    .addCase(
      FAVOURITES_FETCH_REQUEST,
      (state, action: ReturnType<typeof fetchFavouritesRequest>) =>
        updateListById(state, 'favourited_by', action.id, (list) =>
          setLoading(list, true),
        ),
    )
    .addCase(
      FAVOURITES_EXPAND_REQUEST,
      (state, action: ReturnType<typeof expandFavouritesRequest>) =>
        updateListById(state, 'favourited_by', action.id, (list) =>
          setLoading(list, true),
        ),
    )
    .addCase(
      FAVOURITES_FETCH_FAIL,
      (state, action: ReturnType<typeof fetchFavouritesFail>) =>
        updateListById(state, 'favourited_by', action.id, (list) =>
          setLoading(list, false),
        ),
    )
    .addCase(
      FAVOURITES_EXPAND_FAIL,
      (state, action: ReturnType<typeof expandFavouritesFail>) =>
        updateListById(state, 'favourited_by', action.id, (list) =>
          setLoading(list, false),
        ),
    )
    // Follow requests
    .addCase(notificationsUpdate, (state, action) =>
      action.payload.notification.type === 'follow_request'
        ? normalizeFollowRequest(state, action.payload.notification)
        : state,
    )
    .addCase(
      FOLLOW_REQUESTS_FETCH_SUCCESS,
      (state, action: ReturnType<typeof fetchFollowRequestsSuccess>) =>
        updateSingleList(state, 'follow_requests', () => newList(action)),
    )
    .addCase(
      FOLLOW_REQUESTS_EXPAND_SUCCESS,
      (state, action: ReturnType<typeof expandFollowRequestsSuccess>) =>
        updateSingleList(state, 'follow_requests', (list) =>
          appendToList(list, action),
        ),
    )
    .addCase(FOLLOW_REQUESTS_FETCH_REQUEST, (state) =>
      updateSingleList(state, 'follow_requests', (list) =>
        setLoading(list, true),
      ),
    )
    .addCase(FOLLOW_REQUESTS_EXPAND_REQUEST, (state) =>
      updateSingleList(state, 'follow_requests', (list) =>
        setLoading(list, true),
      ),
    )
    .addCase(FOLLOW_REQUESTS_FETCH_FAIL, (state) =>
      updateSingleList(state, 'follow_requests', (list) =>
        setLoading(list, false),
      ),
    )
    .addCase(FOLLOW_REQUESTS_EXPAND_FAIL, (state) =>
      updateSingleList(state, 'follow_requests', (list) =>
        setLoading(list, false),
      ),
    )
    .addCase(authorizeFollowRequestSuccess, (state, action) =>
      removeFollowRequest(state, action.payload.id),
    )
    .addCase(rejectFollowRequestSuccess, (state, action) =>
      removeFollowRequest(state, action.payload.id),
    )
    // Blocks
    .addCase(
      BLOCKS_FETCH_SUCCESS,
      (state, action: ReturnType<typeof fetchBlocksSuccess>) =>
        updateSingleList(state, 'blocks', () => newList(action)),
    )
    .addCase(
      BLOCKS_EXPAND_SUCCESS,
      (state, action: ReturnType<typeof expandBlocksSuccess>) =>
        updateSingleList(state, 'blocks', (list) => appendToList(list, action)),
    )
    .addCase(BLOCKS_FETCH_REQUEST, (state) =>
      updateSingleList(state, 'blocks', (list) => setLoading(list, true)),
    )
    .addCase(BLOCKS_EXPAND_REQUEST, (state) =>
      updateSingleList(state, 'blocks', (list) => setLoading(list, true)),
    )
    .addCase(BLOCKS_FETCH_FAIL, (state) =>
      updateSingleList(state, 'blocks', (list) => setLoading(list, false)),
    )
    .addCase(BLOCKS_EXPAND_FAIL, (state) =>
      updateSingleList(state, 'blocks', (list) => setLoading(list, false)),
    )
    // Mutes
    .addCase(
      MUTES_FETCH_SUCCESS,
      (state, action: ReturnType<typeof fetchMutesSuccess>) =>
        updateSingleList(state, 'mutes', () => newList(action)),
    )
    .addCase(
      MUTES_EXPAND_SUCCESS,
      (state, action: ReturnType<typeof expandMutesSuccess>) =>
        updateSingleList(state, 'mutes', (list) => appendToList(list, action)),
    )
    .addCase(MUTES_FETCH_REQUEST, (state) =>
      updateSingleList(state, 'mutes', (list) => setLoading(list, true)),
    )
    .addCase(MUTES_EXPAND_REQUEST, (state) =>
      updateSingleList(state, 'mutes', (list) => setLoading(list, true)),
    )
    .addCase(MUTES_FETCH_FAIL, (state) =>
      updateSingleList(state, 'mutes', (list) => setLoading(list, false)),
    )
    .addCase(MUTES_EXPAND_FAIL, (state) =>
      updateSingleList(state, 'mutes', (list) => setLoading(list, false)),
    )
    // Endorsed accounts
    .addCase(fetchEndorsedAccounts.fulfilled, (state, action) =>
      updateListById(state, 'featured_accounts', action.meta.arg.accountId, () =>
        newList({ accounts: action.payload, next: undefined }),
      ),
    )
    .addCase(fetchEndorsedAccounts.pending, (state, action) =>
      updateListById(state, 'featured_accounts', action.meta.arg.accountId, (list) =>
        setLoading(list, true),
      ),
    )
    .addCase(fetchEndorsedAccounts.rejected, (state, action) =>
      updateListById(state, 'featured_accounts', action.meta.arg.accountId, (list) =>
        setLoading(list, false),
      ),
    )
    // Featured tags
    .addCase(fetchFeaturedTags.fulfilled, (state, action) =>
      normalizeFeaturedTags(state, action.meta.arg.accountId, action.payload),
    )
    .addCase(fetchFeaturedTags.pending, (state, action) =>
      setFeaturedTagsLoading(state, action.meta.arg.accountId, true),
    )
    .addCase(fetchFeaturedTags.rejected, (state, action) =>
      setFeaturedTagsLoading(state, action.meta.arg.accountId, false),
    )
    // Directory
    .addCase(fetchDirectory.fulfilled, (state, action) =>
      updateSingleList(state, 'directory', () =>
        newList({
          accounts: action.payload.accounts,
          next: action.payload.isLast ? null : true,
        }),
      ),
    )
    .addCase(expandDirectory.fulfilled, (state, action) =>
      updateSingleList(state, 'directory', (list) =>
        appendToList(list, {
          accounts: action.payload.accounts,
          next: action.payload.isLast ? null : true,
        }),
      ),
    )
    .addMatcher(
      (action) =>
        fetchDirectory.pending.match(action) ||
        expandDirectory.pending.match(action),
      (state) =>
        updateSingleList(state, 'directory', (list) => setLoading(list, true)),
    )
    .addMatcher(
      (action) =>
        fetchDirectory.rejected.match(action) ||
        expandDirectory.rejected.match(action),
      (state) =>
        updateSingleList(state, 'directory', (list) => setLoading(list, false)),
    );
});
