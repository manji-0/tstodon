import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const load = (path: string): unknown => {
  const module: unknown = require(`twitter-text/dist/${path}`);
  return typeof module === "object" && module !== null && "default" in module
    ? module.default
    : module;
};

const pattern = (path: string): RegExp | string => {
  const value = load(path);
  if (value instanceof RegExp || typeof value === "string") {
    return value;
  }
  throw new TypeError(`twitter-text/dist/${path} is not a pattern`);
};

/**
 * twitter-text's URL pattern with the scheme required, as Mastodon's web UI
 * builds it (`features/compose/util/url_regex.js`). Groups: $1 the match,
 * $2 the preceding character, $3 the scheme, $4 the domain, $5 the port,
 * $6 the path, $7 the query. Run at generation and test time only.
 */
export const composePostUrlPattern = (): { source: string; flags: string } => {
  const regexSupplant = load("lib/regexSupplant");
  if (typeof regexSupplant !== "function") {
    throw new TypeError("twitter-text/dist/lib/regexSupplant is not a function");
  }
  const composed: unknown = Reflect.apply(regexSupplant, undefined, [
    "(" +
      "(#{validUrlPrecedingChars})" +
      "(https?:\\/\\/)" +
      "(#{validDomain})" +
      "(?::(#{validPortNumber}))?" +
      "(\\/#{validUrlPath}*)?" +
      "(\\?#{validUrlQueryChars}*#{validUrlQueryEndingChars})?" +
      ")",
    {
      validUrlPrecedingChars: pattern("regexp/validUrlPrecedingChars"),
      validDomain: pattern("regexp/validDomain"),
      validPortNumber: pattern("regexp/validPortNumber"),
      validUrlPath: pattern("regexp/validUrlPath"),
      validUrlQueryChars: pattern("regexp/validUrlQueryChars"),
      validUrlQueryEndingChars: pattern("regexp/validUrlQueryEndingChars"),
    },
    "gi",
  ]);
  if (!(composed instanceof RegExp)) {
    throw new TypeError("regexSupplant returned no RegExp");
  }
  return { source: composed.source, flags: composed.flags };
};
