import { readFileSync } from "node:fs";

/**
 * `[text, entities, countable text, length]` as Mastodon's server has them
 * (`Extractor.extract_entities_with_indices`, `StatusLengthValidator`), an
 * entity being `[U | H | M, start, end]` with UTF-16 indices.
 */
export type MastodonPostText = readonly [
  string,
  ReadonlyArray<readonly [string, number, number]>,
  string,
  number,
];

const isRow = (value: unknown): value is MastodonPostText =>
  Array.isArray(value) &&
  typeof value[0] === "string" &&
  Array.isArray(value[1]) &&
  typeof value[2] === "string" &&
  typeof value[3] === "number";

/**
 * What Mastodon's server makes of a corpus of post texts, for tests: written
 * once from Ruby by `scripts/generate-post-text-fixture.mjs`, which says
 * what the corpus holds and which texts it leaves out.
 */
export const mastodonPostTexts = (): ReadonlyArray<MastodonPostText> => {
  const fixture: unknown = JSON.parse(
    readFileSync(new URL("./post-text.fixture.json", import.meta.url), "utf8"),
  );
  if (!Array.isArray(fixture) || !fixture.every(isRow)) {
    throw new TypeError("post-text.fixture.json is not a list of rows");
  }
  return fixture;
};

/**
 * `[host, ASCII]` as libidn's `IDN::Idna.toASCII` has it, `null` where it
 * raises: written by the same script.
 */
export const libidnHosts = (): ReadonlyArray<readonly [string, string | null]> => {
  const fixture: unknown = JSON.parse(
    readFileSync(new URL("./idna.fixture.json", import.meta.url), "utf8"),
  );
  const isRow = (value: unknown): value is readonly [string, string | null] =>
    Array.isArray(value) &&
    typeof value[0] === "string" &&
    (value[1] === null || typeof value[1] === "string");
  if (!Array.isArray(fixture) || !fixture.every(isRow)) {
    throw new TypeError("idna.fixture.json is not a list of rows");
  }
  return fixture;
};
