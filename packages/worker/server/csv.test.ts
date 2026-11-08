import { describe, expect, it } from "vite-plus/test";
import { CSV_MAX_COLUMNS, formatCsvRecord, parseCsv } from "./csv";

const records = (text: string, max = 100) => {
  const parsed = parseCsv(text, max);
  if (parsed.isErr()) {
    throw new Error(parsed.error.kind);
  }
  return parsed.value;
};

describe("parseCsv", () => {
  it("reads records ended by LF, CRLF or CR, and skips empty lines", () => {
    expect(records("a,b\nc,d\r\n\r\ne,f\rg,h")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
    ]);
  });

  it("reads quoted fields with commas, quotes, and line breaks", () => {
    expect(records('"a, b","say ""hi""","line\nbreak"\n')).toEqual([
      ["a, b", 'say "hi"', "line\nbreak"],
    ]);
  });

  it("keeps empty fields and a quote inside an unquoted field", () => {
    expect(records('a,,c\nit"s,"",x')).toEqual([
      ["a", "", "c"],
      ['it"s', "", "x"],
    ]);
  });

  it("ignores a byte order mark", () => {
    expect(records("﻿Account address\nbob@x.example")).toEqual([
      ["Account address"],
      ["bob@x.example"],
    ]);
  });

  it("refuses an unclosed quote", () => {
    expect(parseCsv('a,"b\nc', 10).isErr()).toBe(true);
  });

  it("refuses a record with too many fields", () => {
    const wide = Array.from({ length: CSV_MAX_COLUMNS + 1 }, () => "x").join(",");
    expect(parseCsv(wide, 10)._unsafeUnwrapErr().kind).toBe("TooManyColumns");
    const ok = Array.from({ length: CSV_MAX_COLUMNS }, () => "x").join(",");
    expect(parseCsv(ok, 10).isOk()).toBe(true);
  });

  it("refuses a file with more records than allowed, instead of cutting it short", () => {
    expect(parseCsv("a\nb\nc", 3).isOk()).toBe(true);
    expect(parseCsv("a\nb\nc\nd", 3)._unsafeUnwrapErr().kind).toBe("TooManyRecords");
  });
});

describe("formatCsvRecord", () => {
  it("quotes only the fields that need it, and round-trips", () => {
    const cells = ["plain", "a, b", 'say "hi"', "two\nlines", ""];
    const line = formatCsvRecord(cells);
    expect(line).toBe('plain,"a, b","say ""hi""","two\nlines",\n');
    expect(records(line)).toEqual([cells]);
  });
});
