import type { Action } from '@reduxjs/toolkit';

/**
 * A matcher for plain-object actions, ones an action creator builds as
 * `{ type: CONSTANT, ... }`: like RTK's `createAction(...).match`, it checks
 * the `type` and types the action as `A`, its creator's return type
 * (`matchAction<ReturnType<typeof importStatus>>(STATUS_IMPORT)`). With the
 * constants declared `as const`, a `type` that is not `A`'s does not
 * compile. Given several types, `A` is the union of their actions
 * (`matchAction<HistoryAction>(HISTORY_FETCH_REQUEST, ...)`), which a
 * `switch (action.type)` then narrows.
 */
export const matchAction = <A extends Action<string>>(
  ...types: A['type'][]
) => {
  const matched: ReadonlySet<string> = new Set(types);
  return (action: Action): action is A => matched.has(action.type);
};
