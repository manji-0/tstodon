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
// indexes (REBUILD below), after the rows those are read from are back.
//
// The conversion fails, and the command exits non-zero, on anything in the
// `writable_schema` part of the dump it does not recognise, on a virtual
// table it has no rebuild for, and on an empty result: a restore must not
// start from SQL that silently lost part of the database.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** How each virtual table of the schema is filled again (migration 0015). */
const REBUILD = {
  status_search:
    "INSERT INTO status_search (rowid, text, tags, scope) SELECT id, text, tags, scope FROM status_search_rows;",
};

const SHADOW_SUFFIXES = ["data", "idx", "content", "docsize", "config"];

/** The dump's statements, split at semicolons outside quotes, brackets and comments. */
const statements = function* (sql) {
  let start = 0;
  let quote;
  // A trigger's body, and a CASE anywhere, hold semicolons or an `END` of
  // their own: a statement ends at a semicolon outside every BEGIN and CASE.
  let depth = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(char) && !/[A-Za-z0-9_$]/.test(sql[index - 1] ?? "")) {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index, index + 64))[0].toUpperCase();
      if (word === "CASE") {
        depth += 1;
      } else if (word === "END") {
        depth = Math.max(0, depth - 1);
      } else if (
        word === "BEGIN" &&
        /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(sql.slice(start, index).trim())
      ) {
        depth += 1;
      }
      index += word.length - 1;
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
    } else if (char === ";" && depth === 0) {
      const statement = sql.slice(start, index + 1).trim();
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

/** An identifier as written: bare, or quoted with `"`, `'`, backticks or brackets. */
const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|'(?:[^']|'')+'|\x60(?:[^\x60]|\x60\x60)+\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)`;

const unquote = (identifier) => {
  const first = identifier[0];
  if (first === "[") {
    return identifier.slice(1, -1);
  }
  if (first === '"' || first === "'" || first === "`") {
    return identifier.slice(1, -1).replaceAll(`${first}${first}`, first);
  }
  return identifier;
};

/** The SQL literals of a `VALUES (...)` list: quoted strings, numbers and NULL. */
const literals = (list) => {
  const values = [];
  const pattern = /\s*(?:'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|(NULL))\s*(,|$)/iy;
  let match;
  while (pattern.lastIndex < list.length && (match = pattern.exec(list)) !== null) {
    values.push(match[1] !== undefined ? match[1].replaceAll("''", "'") : (match[2] ?? null));
    if (match[4] === "") {
      return values;
    }
  }
  return pattern.lastIndex === list.length ? values : undefined;
};

const SCHEMA_INSERT = new RegExp(
  String.raw`^INSERT\s+INTO\s+(?:main\.)?(${IDENTIFIER})\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*;$`,
  "i",
);

/**
 * A `.dump` line that writes the schema table directly: the name and SQL of
 * the virtual table it restores, or why it is not one.
 */
const schemaInsert = (statement) => {
  const match = SCHEMA_INSERT.exec(statement);
  if (
    match === null ||
    !["sqlite_schema", "sqlite_master"].includes(unquote(match[1]).toLowerCase())
  ) {
    return undefined;
  }
  const columns = match[2].split(",").map((column) => unquote(column.trim()).toLowerCase());
  const values = literals(match[3]);
  if (values === undefined || values.length !== columns.length) {
    return { error: "its values do not read" };
  }
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  const sql = row.sql ?? "";
  if (
    row.type !== "table" ||
    typeof row.name !== "string" ||
    !/^CREATE\s+VIRTUAL\s+TABLE\b/i.test(sql)
  ) {
    return { error: "it is not a virtual table" };
  }
  return { name: row.name, sql: `${sql.trim().replace(/;$/, "")};` };
};

const SHADOW_CREATE = new RegExp(
  String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENTIFIER})`,
  "i",
);
const SHADOW_INSERT = new RegExp(String.raw`^INSERT\s+INTO\s+(${IDENTIFIER})`, "i");

const IS_SCHEMA_WRITE = /^INSERT\s+INTO\s+(?:main\.)?["'`[]?sqlite_(schema|master)\b/i;

export const convertDump = (sql) => {
  const all = [...statements(sql)];
  const cliFormat = all.some(
    (statement) =>
      /^PRAGMA\s+writable_schema\b/i.test(statement) || IS_SCHEMA_WRITE.test(statement),
  );
  if (!cliFormat) {
    return sql;
  }
  // The virtual tables come first, so a shadow table is known wherever it is.
  const virtualTables = new Map();
  for (const statement of all.filter((statement) => IS_SCHEMA_WRITE.test(statement))) {
    const insert = schemaInsert(statement);
    if (insert === undefined || "error" in insert) {
      throw new Error(
        `unrecognised write to the schema table (${insert?.error ?? "unreadable"}): ${statement.slice(0, 200)}`,
      );
    }
    if (REBUILD[insert.name] === undefined) {
      throw new Error(`no rebuild for the virtual table ${insert.name}`);
    }
    virtualTables.set(insert.name, insert.sql);
  }
  if (virtualTables.size === 0) {
    throw new Error("the dump writes the schema table but restores no virtual table");
  }
  const shadow = new Set(
    [...virtualTables.keys()].flatMap((name) =>
      SHADOW_SUFFIXES.map((suffix) => `${name}_${suffix}`.toLowerCase()),
    ),
  );
  const shadowName = (statement) => {
    const match = SHADOW_CREATE.exec(statement) ?? SHADOW_INSERT.exec(statement);
    const name = match === null ? undefined : unquote(match[1]).toLowerCase();
    return name !== undefined && shadow.has(name) ? name : undefined;
  };
  // Every table is created before any row is written: D1 enforces foreign
  // keys during the import (`.dump` turns them off), and a row's parent table
  // may come later in the dump.
  const tables = [];
  const rest = [];
  let writableSchema = false;
  for (const statement of all) {
    if (/^PRAGMA\s+writable_schema\s*=\s*(ON|1|TRUE)\s*;$/i.test(statement)) {
      writableSchema = true;
      continue;
    }
    if (/^PRAGMA\s+writable_schema\s*=\s*(OFF|0|FALSE)\s*;$/i.test(statement)) {
      writableSchema = false;
      continue;
    }
    if (IS_SCHEMA_WRITE.test(statement)) {
      tables.push(virtualTables.get(schemaInsert(statement).name));
      continue;
    }
    if (shadowName(statement) !== undefined) {
      continue;
    }
    // `.dump` also writes the AUTOINCREMENT counters and the indexes, views
    // and triggers while the schema is writable; anything else there is a
    // shape this script does not know.
    if (
      writableSchema &&
      !/^(DELETE\s+FROM\s+sqlite_sequence|INSERT\s+INTO\s+["'`]?sqlite_sequence\b|CREATE\s+(UNIQUE\s+)?INDEX\b|CREATE\s+VIEW\b|CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b)/i.test(
        statement,
      )
    ) {
      throw new Error(
        `unrecognised statement while the dump writes the schema: ${statement.slice(0, 200)}`,
      );
    }
    if (
      /^(BEGIN(\s+TRANSACTION)?|COMMIT|PRAGMA\s+foreign_keys\s*=\s*(OFF|0))\s*;$/i.test(
        statement,
      ) ||
      // D1's own tables, which an import may not write, and planner statistics.
      /^(CREATE\s+TABLE(\s+IF\s+NOT\s+EXISTS)?|INSERT\s+INTO)\s+['"`[]?(_cf_|sqlite_stat)/i.test(
        statement,
      ) ||
      /^ANALYZE\s+sqlite_(schema|master)\s*;$/i.test(statement)
    ) {
      continue;
    }
    if (/^CREATE\s+TABLE\b/i.test(statement)) {
      tables.push(statement);
    } else {
      rest.push(statement);
    }
  }
  const rebuilds = [...virtualTables.keys()].map((name) => REBUILD[name]);
  return `${["PRAGMA defer_foreign_keys=TRUE;", ...tables, ...rest, ...rebuilds].join("\n")}\n`;
};

/** Whether this module is the command being run, whatever path or symlink names it. */
const isMain = () => {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
};

if (isMain()) {
  const converted = convertDump(readFileSync(0, "utf8"));
  if (converted.trim().length === 0) {
    console.error("d1-dump-for-import: the dump is empty");
    process.exit(1);
  }
  process.stdout.write(converted);
}
