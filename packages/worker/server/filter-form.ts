import { filterActionOf } from "./routes/filters/shared";

/**
 * The fields of Mastodon's filter form (`/filters/new`, `/filters/:id/edit`),
 * parsed from a flat form post. Contexts, the keyword rows and the statuses to
 * drop are separate fields (`context_home`, `keyword_0`, `remove_status_<id>`)
 * because a plain form cannot post a list under one name.
 */

export const FILTER_CONTEXTS = [
  ["home", "Home and lists"],
  ["notifications", "Notifications"],
  ["public", "Public timelines"],
  ["thread", "Conversations"],
  ["account", "Profiles"],
] as const;

/** Seconds, as Mastodon's "Expire after" menu offers them. */
export const FILTER_EXPIRY_CHOICES = [
  ["never", "Never"],
  ["1800", "30 minutes"],
  ["3600", "1 hour"],
  ["21600", "6 hours"],
  ["43200", "12 hours"],
  ["86400", "1 day"],
  ["604800", "1 week"],
] as const;

/** Keep an existing filter's expiry; only the edit form offers it. */
export const KEEP_EXPIRY = "keep";

export type KeywordRow = Readonly<{
  /** The stored keyword's id, or `""` for a new row. */
  id: string;
  keyword: string;
  wholeWord: boolean;
  remove: boolean;
}>;

export type FilterFormValues = Readonly<{
  title: string;
  /** `never`, a number of seconds from {@link FILTER_EXPIRY_CHOICES}, or {@link KEEP_EXPIRY}. */
  expires: string;
  contexts: ReadonlyArray<string>;
  action: "warn" | "hide";
  keywords: ReadonlyArray<KeywordRow>;
  /** FilterStatus ids the form drops from the filter. */
  removeStatusIds: ReadonlyArray<string>;
}>;

const MAX_TITLE_LENGTH = 255;

export const parseFilterForm = (fields: Readonly<Record<string, string>>): FilterFormValues => {
  const indexes = Object.keys(fields)
    .flatMap((name) => {
      const match = /^keyword_(\d+)$/.exec(name);
      return match?.[1] === undefined ? [] : [Number(match[1])];
    })
    .sort((a, b) => a - b);
  return {
    title: (fields.title ?? "").trim(),
    expires: fields.expires_in ?? "never",
    contexts: FILTER_CONTEXTS.flatMap(([context]) =>
      fields[`context_${context}`] === "1" ? [context] : [],
    ),
    action: filterActionOf(fields.filter_action),
    keywords: indexes.map((index) => ({
      id: fields[`keyword_${index}_id`] ?? "",
      keyword: (fields[`keyword_${index}`] ?? "").trim(),
      wholeWord: fields[`keyword_${index}_whole_word`] === "1",
      remove: fields[`keyword_${index}_remove`] === "1",
    })),
    removeStatusIds: Object.keys(fields).flatMap((name) => {
      const match = /^remove_status_(.+)$/.exec(name);
      return match?.[1] !== undefined && fields[name] === "1" ? [match[1]] : [];
    }),
  };
};

/** The rows a filter keeps: not marked for removal, and not blank. */
export const keptKeywords = (values: FilterFormValues): ReadonlyArray<KeywordRow> =>
  values.keywords.filter((row) => !row.remove && row.keyword.length > 0);

/** What is wrong with the form, in the order the fields appear; empty when it is valid. */
export const filterFormProblems = (
  values: FilterFormValues,
  options: Readonly<{ canKeepExpiry: boolean }>,
): ReadonlyArray<string> => {
  const problems: string[] = [];
  if (values.title.length === 0) {
    problems.push("Enter a title.");
  } else if (values.title.length > MAX_TITLE_LENGTH) {
    problems.push(`The title can have at most ${MAX_TITLE_LENGTH} characters.`);
  }
  const knownExpiry =
    FILTER_EXPIRY_CHOICES.some(([value]) => value === values.expires) ||
    (options.canKeepExpiry && values.expires === KEEP_EXPIRY);
  if (!knownExpiry) {
    problems.push("Choose when the filter expires from the list.");
  }
  if (values.contexts.length === 0) {
    problems.push("Choose at least one place where the filter applies.");
  }
  if (keptKeywords(values).length === 0) {
    problems.push("Add at least one keyword.");
  }
  return problems;
};
