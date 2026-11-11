/**
 * The web UI's OAuth application, and the id of the access token a signed-in
 * Better Auth session gets for it (`server/web-app.ts`). The token is derived
 * from the session, so its id names the session.
 */
export const WEB_APP_ID = "tstodon-web";

export const webAccessTokenId = (sessionId: string): string => `web:${sessionId}`;
