import { SupportedLocales } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";

/**
 * A status search query as Mastodon v4.7.5 reads one (`SearchQueryParser`,
 * `SearchQueryTransformer`): words, `#tags` and quoted phrases that a note
 * must (`+` or nothing) or must not (`-`) contain, and the `has:` / `is:`,
 * `language:`, `from:`, `before:` / `after:` / `during:` filters and the
 * `in:` scope.
 */
export type StatusSearchQuery = Readonly<{
  clauses: ReadonlyArray<StatusSearchClause>;
  scope: StatusSearchScope;
}>;

/**
 * Where a query looks (`in:`): `All` is both indexes, `Library` the viewer's
 * own `StatusesIndex` and `Public` the `PublicStatusesIndex`.
 */
export type StatusSearchScope = "All" | "Library" | "Public";

export type TextOccurrence = "Must" | "MustNot";

/**
 * One clause. `Words` must all appear (Mastodon's `TermClause`, whose
 * `operator: 'and'` match takes every word, anywhere); `Tag` matches the
 * note's hashtags; `Phrase` the words in order.
 */
export type StatusSearchClause =
  | Readonly<{ kind: "Words"; occurrence: TextOccurrence; words: ReadonlyArray<string> }>
  | Readonly<{ kind: "Tag"; occurrence: TextOccurrence; name: string }>
  | Readonly<{ kind: "Phrase"; occurrence: TextOccurrence; words: ReadonlyArray<string> }>
  | Readonly<{ kind: "Property"; negated: boolean; property: string }>
  | Readonly<{ kind: "Language"; negated: boolean; code: string }>
  | Readonly<{ kind: "From"; negated: boolean; author: StatusSearchAuthor }>
  | Readonly<{ kind: "Created"; negated: boolean; range: InstantRange }>;

/** `from:me`, or `from:user` / `from:@user@domain` (the domain absent for `user`). */
export type StatusSearchAuthor =
  | Readonly<{ kind: "Viewer" }>
  | Readonly<{ kind: "Handle"; username: string; domain: string | undefined }>;

/**
 * Epoch milliseconds a creation time must fall in: from `from` (inclusive)
 * up to `until` (exclusive), each unbounded when absent.
 */
export type InstantRange = Readonly<{ from?: number; until?: number }>;

/** The query does not read (Mastodon's `Parslet::ParseFailed`, or a date `Date.iso8601` refuses). */
export type StatusSearchQueryError = Readonly<{ kind: "Unparseable" }>;

/** A parsed clause before its prefix is read: Parslet's `clause` tree. */
type RawClause = Readonly<{
  operator: "+" | "-" | undefined;
  prefix: string | undefined;
  body:
    | Readonly<{ kind: "Term"; term: string }>
    | Readonly<{ kind: "Phrase"; words: ReadonlyArray<string> }>
    | Readonly<{ kind: "Shortcode"; term: string }>;
}>;

const TERM = /^[^\s":]+/;
const SPACE = /^\s+/;

/**
 * `SearchQueryParser`: `query = (clause space?)*`, where a clause is
 * `operator? (term ':')? (phrase | term | shortcode)`, a lone `term ':'`, or a
 * stray `"` (junk, dropped). The input must be read to its end.
 */
const parseClauses = (input: string): RawClause[] | undefined => {
  const clauses: RawClause[] = [];
  let rest = input;
  while (rest.length > 0) {
    const clause = readClause(rest);
    if (clause === undefined) {
      return undefined;
    }
    if (clause.clause !== undefined) {
      clauses.push(clause.clause);
    }
    rest = clause.rest.replace(SPACE, "");
  }
  return clauses;
};

const readClause = (
  input: string,
): Readonly<{ clause: RawClause | undefined; rest: string }> | undefined => {
  const full = readFullClause(input);
  if (full !== undefined) {
    return full;
  }
  // `prefix.as(:clause)`: a term and its colon, read as the term.
  const term = TERM.exec(input);
  if (term !== null && input[term[0].length] === ":") {
    return {
      clause: { operator: undefined, prefix: undefined, body: { kind: "Term", term: term[0] } },
      rest: input.slice(term[0].length + 1),
    };
  }
  return input.startsWith('"') ? { clause: undefined, rest: input.slice(1) } : undefined;
};

const readFullClause = (
  input: string,
): Readonly<{ clause: RawClause; rest: string }> | undefined => {
  const operator = input[0] === "+" || input[0] === "-" ? input[0] : undefined;
  const afterOperator = operator === undefined ? input : input.slice(1);
  const prefixTerm = TERM.exec(afterOperator);
  // A PEG's `prefix.maybe` does not give back a prefix it read: when no body
  // follows it, the whole clause fails.
  if (prefixTerm !== null && afterOperator[prefixTerm[0].length] === ":") {
    const withPrefix = readBody(afterOperator.slice(prefixTerm[0].length + 1));
    return withPrefix === undefined
      ? undefined
      : {
          clause: { operator, prefix: prefixTerm[0], body: withPrefix.body },
          rest: withPrefix.rest,
        };
  }
  const body = readBody(afterOperator);
  return body === undefined
    ? undefined
    : { clause: { operator, prefix: undefined, body: body.body }, rest: body.rest };
};

const readBody = (
  input: string,
): Readonly<{ body: RawClause["body"]; rest: string }> | undefined => {
  const phrase = /^"((?:[^\s"]+\s*)*)"/.exec(input);
  if (phrase !== null) {
    const words = phrase[1]?.split(/\s+/).filter((word) => word.length > 0) ?? [];
    return { body: { kind: "Phrase", words }, rest: input.slice(phrase[0].length) };
  }
  const term = TERM.exec(input);
  if (term !== null) {
    return { body: { kind: "Term", term: term[0] }, rest: input.slice(term[0].length) };
  }
  const shortcode = /^:([^\s":]+):?/.exec(input);
  if (shortcode?.[1] !== undefined) {
    return {
      body: { kind: "Shortcode", term: shortcode[1] },
      rest: input.slice(shortcode[0].length),
    };
  }
  return undefined;
};

const PREFIXES = new Set(["has", "is", "language", "from", "before", "after", "during", "in"]);

const DAY_MS = 86_400_000;

/**
 * `date_from_term`: epoch milliseconds, or an ISO 8601 date or date-time. A
 * date without a time is a whole UTC day (tstodon keeps no time zone per
 * account, where Mastodon reads the viewer's): Elasticsearch fills its
 * missing time with the day's first instant for `lt` / `gte` and its last
 * for `gt` / `lte`.
 */
const dayOrInstant = (term: string): Readonly<{ from: number; until: number }> | undefined => {
  if (/^\d+$/.test(term)) {
    const at = Number(term);
    return { from: at, until: at + 1 };
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(term);
  if (day !== null) {
    const start = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    const valid = new Date(start).toISOString().startsWith(term);
    return valid ? { from: start, until: start + DAY_MS } : undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(term)) {
    return undefined;
  }
  const at = Date.parse(term);
  return Number.isNaN(at) ? undefined : { from: at, until: at + 1 };
};

/** `language_code_from_term`: the code as written, downcased, or its first part, when Mastodon supports it. */
const languageCode = (term: string): string =>
  [term, term.toLowerCase(), (term.split(/[_-]/)[0] ?? term).toLowerCase()].find((code) =>
    SupportedLocales.has(code),
  ) ?? term;

const author = (term: string): StatusSearchAuthor => {
  if (term === "me") {
    return { kind: "Viewer" };
  }
  const [username = "", domain] = term.replace(/^@/, "").split("@");
  return { kind: "Handle", username, domain };
};

type ReadClause =
  | Readonly<{ kind: "Clause"; clause: StatusSearchClause }>
  | Readonly<{ kind: "Scope"; scope: string }>;

/** `SearchQueryTransformer`'s rule for one clause, or `undefined` for a date it refuses. */
const transform = (raw: RawClause): ReadClause | undefined => {
  const prefix = raw.prefix?.toLowerCase();
  const occurrence: TextOccurrence = raw.operator === "-" ? "MustNot" : "Must";
  const negated = raw.operator === "-";
  const term = raw.body.kind === "Phrase" ? raw.body.words.join(" ") : raw.body.term;
  if (prefix !== undefined && PREFIXES.has(prefix)) {
    switch (prefix) {
      case "has":
      case "is":
        return { kind: "Clause", clause: { kind: "Property", negated, property: term } };
      case "language":
        return { kind: "Clause", clause: { kind: "Language", negated, code: languageCode(term) } };
      case "from":
        return { kind: "Clause", clause: { kind: "From", negated, author: author(term) } };
      case "in":
        return { kind: "Scope", scope: term };
      default: {
        const day = dayOrInstant(term);
        if (day === undefined) {
          return undefined;
        }
        const range: InstantRange =
          prefix === "before"
            ? { until: day.from }
            : prefix === "after"
              ? { from: day.until }
              : day;
        return { kind: "Clause", clause: { kind: "Created", negated, range } };
      }
    }
  }
  if (raw.prefix !== undefined) {
    return {
      kind: "Clause",
      clause: { kind: "Words", occurrence, words: [raw.prefix, ...term.split(" ")] },
    };
  }
  if (raw.body.kind === "Phrase") {
    return { kind: "Clause", clause: { kind: "Phrase", occurrence, words: raw.body.words } };
  }
  if (term.startsWith("#")) {
    return { kind: "Clause", clause: { kind: "Tag", occurrence, name: term.slice(1) } };
  }
  return { kind: "Clause", clause: { kind: "Words", occurrence, words: [term] } };
};

const scopeOf = (flag: string | undefined): StatusSearchScope =>
  flag === "library" ? "Library" : flag === "public" ? "Public" : "All";

/**
 * Read a query as Mastodon's status search does. Mastodon replaces curly and
 * other quote marks with `"` first (`SearchService::QUOTE_EQUIVALENT_CHARACTERS`).
 */
const parse = (query: string): Result<StatusSearchQuery, StatusSearchQueryError> => {
  const raws = parseClauses(query.trim().replace(/[“”„«»「」『』《》]/g, '"'));
  if (raws === undefined) {
    return err({ kind: "Unparseable" });
  }
  const clauses: StatusSearchClause[] = [];
  let scope: string | undefined;
  for (const raw of raws) {
    const read = transform(raw);
    if (read === undefined) {
      return err({ kind: "Unparseable" });
    }
    if (read.kind === "Scope") {
      scope = read.scope;
    } else {
      clauses.push(read.clause);
    }
  }
  return ok({ clauses, scope: scopeOf(scope) });
};

export const StatusSearchQuery = { parse } as const;
