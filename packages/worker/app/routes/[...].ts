// Void sorts catch-alls after every other route, so this only sees requests
// no route file matched. A default export (no method exports) serves every method.
export { notFound as default } from "#src/not-found";
