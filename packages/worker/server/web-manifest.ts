import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import manifest from "virtual:tstodon/web-manifest";

/**
 * What the Worker renders Mastodon's web app `<script>` / `<link>` tags from.
 * The Void build writes it (`webManifest` in web-build.ts): from the client
 * build's Vite manifest, or, on the dev server, as the source files Vite
 * serves and hot-reloads.
 */

const EntrySchema = z.object({
  js: z.string(),
  css: z.array(z.string()),
  preload: z.array(z.string()),
});

export type WebEntry = z.infer<typeof EntrySchema>;

export const WebManifestSchema = z.object({
  ref: z.string(),
  /** Vite's dev server: module URLs of the sources, and the HMR client. */
  dev: z.boolean(),
  /** The React Fast Refresh preamble, on the dev server. */
  devPreamble: z.string().optional(),
  /** Modern polyfills (`@vitejs/plugin-legacy`); a build only. */
  polyfills: z.string().optional(),
  themeSelection: z.string(),
  inert: z.string(),
  theme: z.string(),
  /** The stylesheet of the Worker's own HTML pages (`src/styles/entrypoints/pages.scss`). */
  pages: z.string(),
  favicon: z.string(),
  common: EntrySchema,
  application: EntrySchema,
  remoteInteractionHelper: EntrySchema,
  locales: z.array(z.string()),
});

export type WebManifest = z.infer<typeof WebManifestSchema>;

const parsed = schemaResult(WebManifestSchema)(manifest);
if (parsed.isErr()) {
  throw new Error(
    `virtual:tstodon/web-manifest: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
  );
}

/** The web app's entry files in this build. */
export const webManifest: WebManifest = parsed.value;
