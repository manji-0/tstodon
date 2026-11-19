/**
 * A GET that asks for an ActivityPub document, as another server does. One
 * without it is a browser's, which Mastodon sends to the web app's page.
 */
export const ACTIVITY_JSON = {
  headers: { Accept: "application/activity+json" },
} as const satisfies RequestInit;
