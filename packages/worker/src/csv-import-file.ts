import type { ImportRowValue, ImportTypeValue, RowFailureValue } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { parseAccountHandle } from "./account-ref";
import { parseCsv, unguardCell } from "./csv";
import { normalizeDomain } from "./domain-block-store";

/** The largest file accepted, in bytes. Mastodon allows 20 MB; this bounds a Worker's memory. */
export const MAX_IMPORT_BYTES = 1_048_576;

/** The most data rows (not counting a header) in one file. A bigger file is refused whole. */
export const MAX_IMPORT_ROWS = 5000;

/** Longest handle, list title, domain, or post URL a row may hold, in characters. */
export const MAX_HANDLE_LENGTH = 320;
export const MAX_LIST_TITLE_LENGTH = 256;
export const MAX_DOMAIN_LENGTH = 253;
export const MAX_URI_LENGTH = 2048;

/** Most languages one followed account may carry. */
const MAX_FOLLOW_LANGUAGES = 20;

/** How much of a line is kept to show a row that failed. */
const MAX_INPUT_LENGTH = 200;

export type ImportFileError =
  | Readonly<{ kind: "TooLarge" }>
  | Readonly<{ kind: "NotText" }>
  | Readonly<{ kind: "Unreadable" }>
  | Readonly<{ kind: "TooManyRows" }>
  | Readonly<{ kind: "NoRows" }>;

/** One data line of the file: ready to apply, or already known to fail. */
export type ParsedLine =
  | Readonly<{
      kind: "Ready";
      position: number;
      input: string;
      row: ImportRowValue;
      /** What the row names, comparable with the account's existing entries (see {@link entryKey}). */
      key: string;
    }>
  | Readonly<{
      kind: "Rejected";
      position: number;
      input: string;
      failure: RowFailureValue;
    }>;

/** What the parser needs to know about this server. */
export type ImportContext = Readonly<{
  /** The instance domain: a handle without a domain is local, and a status URL here is local. */
  localDomain: string;
  /** The origin of local status URLs, without a trailing slash. */
  publicOrigin: string;
}>;

const KEY_SEPARATOR = "\u001f";

/** The key of an account entry: `user@domain` in lower case, the local domain filled in. */
export const accountKey = (localDomain: string, handle: string): string | undefined => {
  const parsed = parseAccountHandle(handle);
  return parsed ? `${parsed.username}@${parsed.domain ?? localDomain}`.toLowerCase() : undefined;
};

/** The key of a list member: the list's title and the member's account key. */
export const listMemberKey = (title: string, accountKeyValue: string): string =>
  `${title}${KEY_SEPARATOR}${accountKeyValue}`;

/**
 * The column names a type's header row may hold, lower case. Only a row made
 * wholly of these that is not itself a row of the type is a header (see
 * {@link headerColumns}); Mastodon writes none for lists, blocks, domain
 * blocks, or bookmarks, so a first row there is data unless it looks like one
 * of these headers.
 */
const HEADERS: Readonly<Record<ImportTypeValue["kind"], ReadonlyArray<string>>> = {
  Following: ["account address", "acct", "show boosts", "notify on new posts", "languages"],
  Lists: ["list name", "list_name", "title", "account address", "acct"],
  Blocks: ["account address", "acct"],
  Mutes: ["account address", "acct", "hide notifications"],
  DomainBlocks: [],
  Bookmarks: ["uri", "url", "status uri"],
};

const printable = (value: string): boolean => !/\p{Cc}/u.test(value);

/** `true`/`false` as Mastodon writes them; an empty cell is `fallback`. */
const parseFlag = (cell: string | undefined, fallback: boolean): boolean | undefined => {
  const value = (cell ?? "").trim().toLowerCase();
  if (value === "") {
    return fallback;
  }
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  return value === "false" || value === "0" || value === "no" ? false : undefined;
};

const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]+)?$/;

const parseLanguages = (cell: string | undefined): string[] | undefined => {
  const languages = (cell ?? "")
    .split(/[\s,;]+/)
    .map((language) => language.toLowerCase())
    .filter((language) => language !== "");
  if (
    languages.length > MAX_FOLLOW_LANGUAGES ||
    !languages.every((language) => LANGUAGE_PATTERN.test(language))
  ) {
    return undefined;
  }
  return [...new Set(languages)];
};

/** A handle cell: a valid `user` or `user@domain`, within the length limit. */
const handleOf = (cell: string | undefined, context: ImportContext): string | undefined => {
  const handle = (cell ?? "").trim().replace(/^@/, "");
  return handle.length <= MAX_HANDLE_LENGTH &&
    printable(handle) &&
    accountKey(context.localDomain, handle) !== undefined
    ? handle
    : undefined;
};

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The local status a URL names: its ActivityPub id (`/users/:name/statuses/:id`)
 * or its web address (`/@name/:id`) on this server. A URL anywhere else
 * names a post this server does not hold.
 */
const localStatusId = (uri: string, context: ImportContext): string | undefined => {
  if (uri.length > MAX_URI_LENGTH || !printable(uri)) {
    return undefined;
  }
  const url = URL.canParse(uri) ? new URL(uri) : undefined;
  if (!url || url.origin !== new URL(context.publicOrigin).origin) {
    return undefined;
  }
  const match =
    /^\/users\/[A-Za-z0-9_.-]+\/statuses\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname) ??
    /^\/@[A-Za-z0-9_.-]+\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  return match?.[1];
};

type LineOutcome =
  | Readonly<{ kind: "Ready"; row: ImportRowValue; key: string }>
  | Readonly<{ kind: "Rejected"; failure: RowFailureValue }>;

const malformed: LineOutcome = { kind: "Rejected", failure: { kind: "Malformed" } };

/** Column index by lower-case header name, when the file has a header. */
type Columns = ReadonlyMap<string, number>;

const cellAt = (
  cells: ReadonlyArray<string>,
  columns: Columns | undefined,
  name: string,
  position: number,
): string | undefined => cells[columns?.get(name) ?? position];

const parseLine = (
  type: ImportTypeValue,
  cells: ReadonlyArray<string>,
  columns: Columns | undefined,
  context: ImportContext,
): LineOutcome => {
  switch (type.kind) {
    case "Following": {
      const handle = handleOf(cellAt(cells, columns, "account address", 0), context);
      const reblogs = parseFlag(cellAt(cells, columns, "show boosts", 1), true);
      const notify = parseFlag(cellAt(cells, columns, "notify on new posts", 2), false);
      const languages = parseLanguages(cellAt(cells, columns, "languages", 3));
      const key = handle === undefined ? undefined : accountKey(context.localDomain, handle);
      return handle === undefined ||
        key === undefined ||
        reblogs === undefined ||
        notify === undefined ||
        languages === undefined
        ? malformed
        : { kind: "Ready", row: { kind: "Following", handle, reblogs, notify, languages }, key };
    }
    case "Blocks": {
      const handle = handleOf(cells[0], context);
      const key = handle === undefined ? undefined : accountKey(context.localDomain, handle);
      return handle === undefined || key === undefined
        ? malformed
        : { kind: "Ready", row: { kind: "Blocks", handle }, key };
    }
    case "Mutes": {
      const handle = handleOf(cellAt(cells, columns, "account address", 0), context);
      const hideNotifications = parseFlag(cellAt(cells, columns, "hide notifications", 1), true);
      const key = handle === undefined ? undefined : accountKey(context.localDomain, handle);
      return handle === undefined || key === undefined || hideNotifications === undefined
        ? malformed
        : { kind: "Ready", row: { kind: "Mutes", handle, hideNotifications }, key };
    }
    case "Lists": {
      const listTitle = (cells[0] ?? "").trim();
      const handle = handleOf(cells[1], context);
      const member = handle === undefined ? undefined : accountKey(context.localDomain, handle);
      return listTitle === "" ||
        listTitle.length > MAX_LIST_TITLE_LENGTH ||
        !printable(listTitle) ||
        handle === undefined ||
        member === undefined
        ? malformed
        : {
            kind: "Ready",
            row: { kind: "Lists", listTitle, handle },
            key: listMemberKey(listTitle, member),
          };
    }
    case "DomainBlocks": {
      const domain = normalizeDomain(cells[0] ?? "");
      return domain === "" || domain.length > MAX_DOMAIN_LENGTH || !HOST_PATTERN.test(domain)
        ? malformed
        : { kind: "Ready", row: { kind: "DomainBlocks", domain }, key: domain };
    }
    case "Bookmarks": {
      const uri = (cells[0] ?? "").trim();
      if (uri === "" || uri.length > MAX_URI_LENGTH || !printable(uri) || !URL.canParse(uri)) {
        return malformed;
      }
      const statusId = localStatusId(uri, context);
      return statusId === undefined
        ? { kind: "Rejected", failure: { kind: "Unsupported" } }
        : { kind: "Ready", row: { kind: "Bookmarks", statusId }, key: statusId };
    }
  }
};

/**
 * The file's header record: a first record whose every cell is a column name
 * of the type and that is not a valid row of the type. A data row such as
 * `title,acct` (a list called "title" holding the account "acct") is valid, so
 * it is data; `Account address,Show boosts,...` is not, so it is a header.
 */
const headerColumns = (
  type: ImportTypeValue,
  first: ReadonlyArray<string> | undefined,
  context: ImportContext,
): Columns | undefined => {
  const names = HEADERS[type.kind];
  if (
    first === undefined ||
    first.length === 0 ||
    !first.every((cell) => names.includes(cell.trim().toLowerCase())) ||
    parseLine(type, first, undefined, context).kind === "Ready"
  ) {
    return undefined;
  }
  return new Map(
    first.map((cell, index) => {
      const column = cell.trim().toLowerCase();
      return [column === "acct" ? "account address" : column, index] as const;
    }),
  );
};

/**
 * The lines of an import file of `type`, in file order, each ready to apply
 * or already failed. The file is refused whole when it is over
 * {@link MAX_IMPORT_BYTES}, is not UTF-8 text, has an unclosed quote or too
 * many columns, has more than {@link MAX_IMPORT_ROWS} rows, or has none. A
 * header row is skipped; a line that is not a row of the type fails alone.
 */
export const parseImportFile = (
  type: ImportTypeValue,
  bytes: Uint8Array,
  context: ImportContext,
): Result<ReadonlyArray<ParsedLine>, ImportFileError> => {
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    return err({ kind: "TooLarge" });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return err({ kind: "NotText" });
  }
  // One record more than the cap, for a header.
  const parsed = parseCsv(text, MAX_IMPORT_ROWS + 1);
  if (parsed.isErr()) {
    return err({ kind: parsed.error.kind === "TooManyRecords" ? "TooManyRows" : "Unreadable" });
  }
  // An export guards cells that a spreadsheet would run as formulas; undo that.
  const records = parsed.value.map((cells) => cells.map(unguardCell));
  const columns = headerColumns(type, records[0], context);
  const dataRecords = columns === undefined ? records : records.slice(1);
  if (dataRecords.length > MAX_IMPORT_ROWS) {
    return err({ kind: "TooManyRows" });
  }
  if (dataRecords.length === 0) {
    return err({ kind: "NoRows" });
  }
  return ok(
    dataRecords.map((cells, index): ParsedLine => {
      const position = index + 1;
      const input = cells.join(",").slice(0, MAX_INPUT_LENGTH);
      const outcome = parseLine(type, cells, columns, context);
      return outcome.kind === "Ready"
        ? { kind: "Ready", position, input, row: outcome.row, key: outcome.key }
        : { kind: "Rejected", position, input, failure: outcome.failure };
    }),
  );
};
