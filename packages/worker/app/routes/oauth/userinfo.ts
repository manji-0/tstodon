export { getOauthUserinfo as GET } from "#server/routes/oauth-userinfo";
// OpenID Connect asks the UserInfo endpoint to take `POST` too, as Mastodon does.
export { getOauthUserinfo as POST } from "#server/routes/oauth-userinfo";
