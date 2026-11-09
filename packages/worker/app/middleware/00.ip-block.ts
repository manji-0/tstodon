// IP blocks with severity `no_access` refuse every request from their range,
// federation included (see server/ip-access.ts and docs/reference/configuration.md).
export { ipAccessMiddleware as default } from "#server/ip-access";
