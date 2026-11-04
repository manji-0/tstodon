import { err, ok, type Result } from "neverthrow";

/**
 * RFC 4180 CSV, as Ruby's `CSV` writes and reads it for Mastodon's data
 * export: commas, `"` quoting with `""` for a quote, records ended by LF,
 * CRLF or CR, and a UTF-8 byte order mark ignored.
 */

/** The most fields one record may have; a longer one is not a file of any type here. */
export const CSV_MAX_COLUMNS = 8;

export type CsvError =
  /** A quoted field never closes. */
  | Readonly<{ kind: "UnterminatedQuote" }>
  | Readonly<{ kind: "TooManyColumns" }>
  /** The file has more records than the caller allows. */
  | Readonly<{ kind: "TooManyRecords" }>;

/**
 * The records of `text`, skipping empty lines. A quote inside an unquoted
 * field is kept as it is; text after the closing quote of a quoted field is
 * appended to it. At most `maxRecords` records are read: one more is an
 * error, so a file is refused instead of cut short.
 */
export const parseCsv = (
  text: string,
  maxRecords: number,
): Result<ReadonlyArray<ReadonlyArray<string>>, CsvError> => {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  /** Whether the current record has any character, so an empty line adds no record. */
  let started = false;

  const endRecord = (): Result<void, CsvError> => {
    if (started) {
      record.push(field);
      if (record.length > CSV_MAX_COLUMNS) {
        return err({ kind: "TooManyColumns" });
      }
      if (records.length >= maxRecords) {
        return err({ kind: "TooManyRecords" });
      }
      records.push(record);
    }
    record = [];
    field = "";
    started = false;
    return ok(undefined);
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (inQuotes) {
      if (char !== '"') {
        field += char;
      } else if (source.charAt(index + 1) === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = false;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      inQuotes = true;
      started = true;
    } else if (char === ",") {
      started = true;
      record.push(field);
      field = "";
      if (record.length >= CSV_MAX_COLUMNS) {
        return err({ kind: "TooManyColumns" });
      }
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source.charAt(index + 1) === "\n") {
        index += 1;
      }
      const ended = endRecord();
      if (ended.isErr()) {
        return err(ended.error);
      }
    } else {
      started = true;
      field += char;
    }
  }
  if (inQuotes) {
    return err({ kind: "UnterminatedQuote" });
  }
  const ended = endRecord();
  return ended.isErr() ? err(ended.error) : ok(records);
};

const needsQuotes = /[",\r\n]/;

const csvField = (cell: string): string =>
  needsQuotes.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;

/** One record as a CSV line, ended by LF. */
export const formatCsvRecord = (cells: ReadonlyArray<string>): string =>
  `${cells.map(csvField).join(",")}\n`;
