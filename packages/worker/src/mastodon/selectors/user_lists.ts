import { createAppSelector } from '../store';

/** The user lists kept by account. */
type ListByAccount = 'followers' | 'following';

export const selectUserListWithoutMe = createAppSelector(
  [
    (state) => state.user_lists,
    (state) => state.meta.get('me') ?? null,
    (_state, listName: ListByAccount) => listName,
    (_state, _listName, accountId?: string | null) => accountId ?? null,
  ],
  (lists, currentAccountId, listName, accountId) => {
    if (!accountId || !listName) {
      return null;
    }
    const list = lists.get(listName).get(accountId);
    if (!list) {
      return null;
    }

    // Returns the list except the current account.
    return {
      items: (list.get('items')?.toArray() ?? []).filter(
        (id) => id !== currentAccountId,
      ),
      isLoading: !!list.get('isLoading', true),
      hasMore: !!list.get('next'),
    };
  },
);
