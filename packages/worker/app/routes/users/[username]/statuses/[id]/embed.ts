// Mastodon serves a status's embed page at /users/:username/statuses/:id/embed as well as /@username/:id/embed.
export { getUsersByUsernameStatusesByIdEmbed as GET } from "#server/routes/status-embed";
