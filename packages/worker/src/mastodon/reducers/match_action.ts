import type { Action } from '@reduxjs/toolkit';

/**
 * A matcher for a plain-object action, one an action creator builds as
 * `{ type: CONSTANT, ... }`: like RTK's `createAction(...).match`, it checks
 * the `type` and types the action as `A`, its creator's return type
 * (`matchAction<ReturnType<typeof importStatus>>(STATUS_IMPORT)`). With the
 * constant declared `as const`, a `type` that is not `A`'s does not compile.
 */
export const matchAction =
  <A extends Action<string>>(type: A['type']) =>
  (action: Action): action is A =>
    action.type === type;
