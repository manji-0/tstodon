const REMEMBER_MS = 6 * 60 * 60 * 1000;

/**
 * An `Undo` handled before the activity it undoes, remembered so that
 * activity is dropped when it comes. Mastodon remembers one for six hours
 * (`ActivityPub::Activity#delete_later!`).
 */
export const UndoneBeforeArrival = {
  rememberMs: REMEMBER_MS,
  /** An `Undo` remembered before this instant (ISO) is forgotten. */
  forgottenBefore: (nowMs: number): string => new Date(nowMs - REMEMBER_MS).toISOString(),
} as const;
