// Lets Node (tsx) load Worker modules that only build documents, as
// own-activity-documents.ts does: their imports reach `cloudflare:workers`
// and the Void build's `virtual:tstodon/web-manifest`, which only workerd and
// Vite resolve. Neither is called while building a document.
//
//   tsx --import ./scripts/worker-module-stubs.mjs <script>
import { register } from "node:module";

const entry = { js: "", css: [], preload: [] };
const manifest = {
  ref: "stub",
  dev: false,
  themeSelection: "",
  inert: "",
  theme: "",
  pages: "",
  favicon: "",
  common: entry,
  application: entry,
  remoteInteractionHelper: entry,
  embed: entry,
  share: entry,
  locales: [],
};

const modules = {
  "cloudflare:workers": [
    "export class DurableObject {}",
    "export class WorkflowEntrypoint {}",
    "export const waitUntil = () => {};",
    "export const env = {};",
  ].join("\n"),
  "virtual:tstodon/web-manifest": `export default ${JSON.stringify(manifest)};`,
};

const urls = Object.fromEntries(
  Object.entries(modules).map(([specifier, source]) => [
    specifier,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);

const hooks = `
const urls = ${JSON.stringify(urls)};
export const resolve = (specifier, context, next) =>
  specifier in urls ? { url: urls[specifier], shortCircuit: true } : next(specifier, context);
`;

register(`data:text/javascript,${encodeURIComponent(hooks)}`);
