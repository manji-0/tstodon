/**
 * How recent a sign-in must be for an action that moves or locks an account:
 * moving it, adding or removing a passkey, ending sessions, revoking apps.
 * Mastodon asks for the password again; here a passkey sign-in on the page
 * starts a fresh session.
 */
export const RECENT_SIGN_IN_WINDOW_MS = 10 * 60 * 1000;

/** Whether a session started too long ago to authorize such an action. */
export const signInIsStale = (signedInAt: Date, now: number = Date.now()): boolean =>
  now - signedInAt.getTime() > RECENT_SIGN_IN_WINDOW_MS;
