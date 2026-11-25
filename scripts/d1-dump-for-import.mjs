#!/usr/bin/env node
// Turns a `wrangler d1 export --compatibility sqlite3_cli_only` dump (the
// SQLite CLI's `.dump`, which D1 cannot import) into SQL that
// `wrangler d1 execute --file` loads, and passes a standard D1 dump through
// unchanged.
//
//   node scripts/d1-dump-for-import.mjs < dump.sql > restore.sql
//
// D1 refuses `PRAGMA writable_schema`, through which `.dump` restores a
// virtual table, and the transaction statements around the dump. So each
// virtual table is created with its `CREATE VIRTUAL TABLE` statement, its
// shadow tables (`<name>_data`, `_idx`, `_content`, `_docsize`, `_config`)
// are left out, and the index is written again at the end from the tables it
// indexes (REBUILD below), after the rows those are read from are back. A
// virtual table this script has no rebuild for fails the conversion.
import { readFileSync } from "node:fs";

/** How each virtual table of the schema is filled again (migration 0015). */
const REBUILD = {
  status_search:
    "INSERT INTO status_search (rowid, text, tags, scope) SELECT id, text, tags, scope FROM status_search_rows;",
};

const SHADOW_SUFFIXES = ["data", "idx", "content", "docsize", "config"];

/** The dump's statements, split at semicolons outside quotes and brackets. */
const statements = function* (sql) {
  let start = 0;
  let quote;
  let inTrigger = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    // A comment in a view's or trigger's SQL may hold a quote of its own.
    if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
    } else if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 1;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "[") {
      quote = "]";
    } else if (char === ";") {
      const statement = sql.slice(start, index + 1).trim();
      // A trigger's body holds semicolons of its own; it ends with `END;`.
      if (!inTrigger && /^CREATE\s+TRIGGER\b/i.test(statement)) {
        inTrigger = true;
      }
      if (inTrigger && !/\bEND\s*;$/i.test(statement)) {
        continue;
      }
      inTrigger = false;
      if (statement.length > 0) {
        yield statement;
      }
      start = index + 1;
    }
  }
  const rest = sql.slice(start).trim();
  if (rest.length > 0) {
    yield rest;
  }
};

const VIRTUAL_TABLE =
  /^INSERT INTO sqlite_schema\s*\(type,name,tbl_name,rootpage,sql\)\s*VALUES\s*\('table','([^']+)','[^']+',0,'(CREATE VIRTUAL TABLE[\s\S]*)'\);$/i;

export const convertDump = (sql) => {
  if (!/^PRAGMA writable_schema\s*=\s*ON;/im.test(sql)) {
    return sql;
  }
  const all = [...statements(sql)];
  const virtualTables = all.flatMap((statement) => VIRTUAL_TABLE.exec(statement)?.[1] ?? []);
  const shadow = new Set(
    virtualTables.flatMap((name) => SHADOW_SUFFIXES.map((suffix) => `${name}_${suffix}`)),
  );
  const shadowTable = (statement) => {
    const name =
      /^CREATE TABLE IF NOT EXISTS '([^']+)'/i.exec(statement)?.[1] ??
      /^INSERT INTO "?([A-Za-z0-9_]+)"? VALUES/i.exec(statement)?.[1];
    return name !== undefined && shadow.has(name);
  };
  // Every table is created before any row is written: D1 enforces foreign
  // keys during the import (`.dump` turns them off), and a row's parent table
  // may come later in the dump.
  const tables = [];
  const rest = [];
  for (const statement of all) {
    if (
      /^(BEGIN TRANSACTION|COMMIT|PRAGMA foreign_keys\s*=\s*OFF|PRAGMA writable_schema\s*=\s*(ON|OFF));$/i.test(
        statement,
      ) ||
      shadowTable(statement) ||
      // D1's own tables, which an import may not write, and planner statistics.
      /^(CREATE TABLE( IF NOT EXISTS)?|INSERT INTO)\s+['"`]?(_cf_|sqlite_stat)/i.test(statement) ||
      /^ANALYZE sqlite_schema;$/i.test(statement)
    ) {
      continue;
    }
    const virtual = VIRTUAL_TABLE.exec(statement);
    if (virtual !== null) {
      tables.push(`${virtual[2].replaceAll("''", "'")};`);
    } else if (/^CREATE TABLE\b/i.test(statement)) {
      tables.push(statement);
    } else {
      rest.push(statement);
    }
  }
  const rebuilds = virtualTables.map((name) => {
    const rebuild = REBUILD[name];
    if (rebuild === undefined) {
      throw new Error(`no rebuild for the virtual table ${name}`);
    }
    return rebuild;
  });
  return `${["PRAGMA defer_foreign_keys=TRUE;", ...tables, ...rest, ...rebuilds].join("\n")}\n`;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(convertDump(readFileSync(0, "utf8")));
}
