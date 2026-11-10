export { getV2NotificationsPolicy as GET } from "#server/routes/notification-requests";
export { patchV2NotificationsPolicy as PATCH } from "#server/routes/notification-requests";
// The web UI updates the policy with `PUT`; Rails routes both verbs to `update`.
export { patchV2NotificationsPolicy as PUT } from "#server/routes/notification-requests";
