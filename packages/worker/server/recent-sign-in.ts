/**
 * How recent an Access login must be for an action that moves or locks an
 * account: moving it, ending the local session, revoking apps. Mastodon asks
 * for the password again; here the Access JWT `iat` has to be inside the window.
 */
export const RECENT_SIGN_IN_WINDOW_MS = 10 * 60 * 1000;

/** Whether a session started too long ago to authorize such an action. */
export const signInIsStale = (signedInAt: Date, now: number = Date.now()): boolean =>
  now - signedInAt.getTime() > RECENT_SIGN_IN_WINDOW_MS;
