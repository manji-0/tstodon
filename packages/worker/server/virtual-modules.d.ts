// Modules the Void build provides (see web-build.ts).

/** The client build's entry files for the web app's shell; parsed in web-manifest.ts. */
declare module "virtual:tstodon/web-manifest" {
  const manifest: unknown;
  export default manifest;
}
