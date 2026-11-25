import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { convertDump } from "./d1-dump-for-import.mjs";

const VIRTUAL =
  "CREATE VIRTUAL TABLE status_search USING fts5(\n  text, tags, scope,\n  content = '''',\n  contentless_delete = 1\n)";

/** A dump as the SQLite CLI's `.dump` writes one, around `schemaWrite`. */
const cliDump = (schemaWrite) => `PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE statuses (id TEXT PRIMARY KEY, reblog_of_remote_id TEXT REFERENCES remote_statuses(id));
INSERT INTO statuses VALUES('1',NULL);
CREATE TABLE remote_statuses (id TEXT PRIMARY KEY, note TEXT);
INSERT INTO remote_statuses VALUES('2','it''s; a note');
PRAGMA writable_schema=ON;
${schemaWrite}
CREATE TABLE IF NOT EXISTS 'status_search_data'(id INTEGER PRIMARY KEY, block BLOB);
INSERT INTO status_search_data VALUES(1,X'00');
CREATE TABLE IF NOT EXISTS "status_search_config"(k PRIMARY KEY, v) WITHOUT ROWID;
INSERT INTO "status_search_config" VALUES('version',4);
PRAGMA writable_schema=OFF;
CREATE VIEW status_search_rows AS
SELECT id -- the row's id; it's the status id
FROM statuses;
CREATE TRIGGER t AFTER INSERT ON statuses BEGIN
  DELETE FROM status_search WHERE rowid = 1;
  UPDATE statuses SET id = CASE WHEN id = 'END;' THEN id ELSE id END;
END;
COMMIT;
`;

const SCHEMA_WRITE = `INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','status_search','status_search',0,'${VIRTUAL}');`;

describe("convertDump", () => {
  it("passes a D1-format dump through unchanged", () => {
    const d1 = "PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE a (id);\nINSERT INTO a VALUES(1);\n";
    expect(convertDump(d1)).toBe(d1);
  });

  it("creates every table first, the virtual table without its shadow tables, and rebuilds it last", () => {
    const lines = convertDump(cliDump(SCHEMA_WRITE)).trim().split(/;\n/);
    expect(lines[0]).toBe("PRAGMA defer_foreign_keys=TRUE");
    expect(lines.slice(1, 4)).toEqual([
      expect.stringMatching(/^CREATE TABLE statuses /),
      expect.stringMatching(/^CREATE TABLE remote_statuses /),
      "CREATE VIRTUAL TABLE status_search USING fts5(\n  text, tags, scope,\n  content = '',\n  contentless_delete = 1\n)",
    ]);
    expect(lines.at(-1)).toMatch(/^INSERT INTO status_search \(rowid, text, tags, scope\) SELECT/);
    const output = lines.join("\n");
    expect(output).not.toMatch(
      /status_search_(data|config)|writable_schema|BEGIN TRANSACTION|COMMIT/,
    );
    expect(output).toContain("INSERT INTO remote_statuses VALUES('2','it''s; a note')");
    expect(output).toContain("END");
  });

  it("reads `sqlite_master` and quoted names", () => {
    const write = `INSERT INTO "sqlite_master" ("type", "name", "tbl_name", "rootpage", "sql") VALUES ('table', 'status_search', 'status_search', 0, '${VIRTUAL}');`;
    expect(convertDump(cliDump(write))).toContain("CREATE VIRTUAL TABLE status_search USING fts5(");
  });

  it("fails on what it does not recognise", () => {
    expect(() =>
      convertDump(cliDump(SCHEMA_WRITE.replaceAll("status_search", "other_index"))),
    ).toThrow(/no rebuild for the virtual table other_index/);
    expect(() =>
      convertDump(
        cliDump(
          "INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','x','x',0,'CREATE TABLE x(a)');",
        ),
      ),
    ).toThrow(/not a virtual table/);
    expect(() =>
      convertDump(cliDump(`${SCHEMA_WRITE}\nCREATE TABLE IF NOT EXISTS 'mystery'(a);`)),
    ).toThrow(/unrecognised statement/);
    expect(() => convertDump("PRAGMA writable_schema=ON;\nPRAGMA writable_schema=OFF;\n")).toThrow(
      /restores no virtual table/,
    );
  });
});

describe("the command", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dump convert "));
  const linked = path.join(directory, "linked script.mjs");
  symlinkSync(path.join(import.meta.dirname, "d1-dump-for-import.mjs"), linked);
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  const run = (input) => spawnSync(process.execPath, [linked], { input, encoding: "utf8" });

  it("converts through a symlink under a path with a space", () => {
    const result = run(cliDump(SCHEMA_WRITE));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CREATE VIRTUAL TABLE status_search");
  });

  it("exits non-zero on an empty dump and on one it cannot convert", () => {
    expect(run("").status).toBe(1);
    expect(run("PRAGMA writable_schema=ON;\n").status).toBe(1);
  });
});
