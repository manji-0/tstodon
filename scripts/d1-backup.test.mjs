import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { backupKey, parseBackupKey, selectPrunable } from "./d1-backup.mjs";

const root = path.join(import.meta.dirname, "..");
const script = path.join(import.meta.dirname, "d1-backup.mjs");
const options = { prefix: "d1/", database: "tstodon" };
const key = (iso) => backupKey("d1/", "tstodon", new Date(iso));

describe("backup keys", () => {
  it("names a backup by database and UTC second", () => {
    expect(key("2026-11-09T03:43:07.512Z")).toBe("d1/tstodon-20261109T034307Z.sql.gz.age");
    expect(backupKey("", "tstodon-staging", new Date("2027-01-02T00:00:00Z"))).toBe(
      "tstodon-staging-20270102T000000Z.sql.gz.age",
    );
  });

  it("reads the time back from a key", () => {
    expect(parseBackupKey("d1/", "tstodon", key("2026-11-09T03:43:07Z"))?.toISOString()).toBe(
      "2026-11-09T03:43:07.000Z",
    );
  });

  it("does not take other objects for backups", () => {
    for (const other of [
      "d1/tstodon-20261109T034307Z.sql",
      "d1/tstodon-20261109T034307Z.sql.gz.age.tmp",
      "d1/tstodon-staging-20261109T034307Z.sql.gz.age",
      "media/tstodon-20261109T034307Z.sql.gz.age",
      "d1/tstodon-20261340T034307Z.sql.gz.age",
      "d1/tstodon-20260230T000000Z.sql.gz.age",
      "d1/tstodon-2026119T034307Z.sql.gz.age",
    ]) {
      expect(parseBackupKey("d1/", "tstodon", other)).toBeUndefined();
    }
  });
});

describe("retention", () => {
  const daily = (from, days) =>
    Array.from({ length: days }, (_, day) =>
      key(new Date(Date.parse(from) + day * 24 * 60 * 60 * 1000).toISOString()),
    );

  it("keeps the last keepDays days and the first backup of each recent month", () => {
    // Daily backups from 2025-09-01 to 2026-11-09 (435 days).
    const keys = daily("2025-09-01T03:43:00Z", 435);
    const now = new Date("2026-11-09T04:00:00Z");
    const prunable = new Set(selectPrunable(keys, { ...options, now }));
    const kept = keys.filter((candidate) => !prunable.has(candidate));
    const monthly = kept.filter((candidate) => /-\d{6}01T/.test(candidate));
    // The first of each month from 2025-12 to 2026-11 (12 months).
    expect(monthly.map((candidate) => candidate.slice(11, 17))).toEqual([
      "202512",
      "202601",
      "202602",
      "202603",
      "202604",
      "202605",
      "202606",
      "202607",
      "202608",
      "202609",
      "202610",
      "202611",
    ]);
    // 35 days back from 2026-11-09T04:00Z: 2026-10-06 onwards (35 dailies).
    const recent = kept.filter((candidate) => candidate >= "d1/tstodon-20261005T034300Z");
    expect(recent[0]).toBe("d1/tstodon-20261006T034300Z.sql.gz.age");
    expect(recent).toHaveLength(35);
    // 2026-11-01 is both a monthly and a daily.
    expect(kept).toHaveLength(35 + 12 - 1);
    expect(prunable.has("d1/tstodon-20251101T034300Z.sql.gz.age")).toBe(true);
    expect(prunable.has("d1/tstodon-20261005T034300Z.sql.gz.age")).toBe(true);
  });

  it("keeps the newest backups when the schedule stopped long ago", () => {
    const keys = daily("2025-01-01T03:43:00Z", 10);
    const prunable = selectPrunable(keys, {
      ...options,
      now: new Date("2026-11-09T00:00:00Z"),
      keepLatest: 3,
    });
    expect(prunable).toEqual(keys.slice(0, 7));
  });

  it("never selects unknown objects and handles duplicates and order", () => {
    const keys = [
      "d1/README.txt",
      key("2024-03-02T00:00:00Z"),
      "d1/tstodon-staging-20240301T000000Z.sql.gz.age",
      key("2024-03-01T00:00:00Z"),
      key("2024-03-02T00:00:00Z"),
      key("2026-11-08T00:00:00Z"),
    ];
    expect(
      selectPrunable(keys, {
        ...options,
        now: new Date("2026-11-09T00:00:00Z"),
        keepLatest: 1,
      }),
    ).toEqual([key("2024-03-01T00:00:00Z"), key("2024-03-02T00:00:00Z")]);
  });

  it("keeps the first backup of a month even when it is not on the first", () => {
    const keys = [key("2026-10-14T00:00:00Z"), key("2026-10-20T00:00:00Z")];
    expect(
      selectPrunable(keys, {
        ...options,
        now: new Date("2026-12-30T00:00:00Z"),
        keepDays: 1,
        keepLatest: 0,
      }),
    ).toEqual([key("2026-10-20T00:00:00Z")]);
  });
});

describe("command line", () => {
  const run = (args, input = "") =>
    execFileSync(process.execPath, [script, ...args], { input, stdio: "pipe" });

  it("prints a key and the prunable keys", () => {
    expect(run(["key", "--at", "2026-11-09T03:43:07Z"]).toString()).toBe(
      "d1/tstodon-20261109T034307Z.sql.gz.age\n",
    );
    // 01-15 is January's first, 01-25 the newest.
    const keys = ["2026-01-15", "2026-01-20", "2026-01-25"]
      .map((day) => key(`${day}T00:00:00Z`))
      .join("\n");
    expect(
      run(["prune", "--now", "2026-11-09T00:00:00Z", "--keep-latest", "1"], `${keys}\n`).toString(),
    ).toBe("d1/tstodon-20260120T000000Z.sql.gz.age\n");
  });

  it("refuses bad options", () => {
    expect(() => run(["prune", "--keep-days", "-1"])).toThrow();
    expect(() => run(["key", "--database", "../x"])).toThrow();
    expect(() => run(["restore"])).toThrow();
  });
});

describe("backup workflow", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/d1-backup.yml"), "utf8");
  const runbook = readFileSync(path.join(root, "docs/operations/runbook.md"), "utf8");

  it("runs on a schedule and on demand", () => {
    expect(workflow).toMatch(/^ {2}schedule:\n {4}- cron: "[^"]+"$/m);
    expect(workflow).toMatch(/^ {2}workflow_dispatch:/m);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it("documents every secret and variable it reads", () => {
    const names = new Set(
      [...workflow.matchAll(/\$\{\{\s*(?:secrets|vars)\.([A-Z0-9_]+)/g)].map((match) => match[1]),
    );
    expect(names.size).toBeGreaterThan(5);
    for (const name of names) {
      expect(runbook, name).toContain(`\`${name}\``);
    }
  });

  it("passes secrets to shell steps only through env", () => {
    const lines = workflow.split("\n");
    let inRun = false;
    let runIndent = 0;
    for (const line of lines) {
      const indent = line.length - line.trimStart().length;
      if (inRun && line.trim() !== "" && indent <= runIndent) {
        inRun = false;
      }
      if (/^\s*run: [|>]/.test(line)) {
        inRun = true;
        runIndent = indent;
        continue;
      }
      if (inRun || /^\s*run: /.test(line)) {
        expect(line, line).not.toMatch(/\$\{\{\s*(secrets|vars|github\.event)\./);
      }
    }
  });

  it("encrypts before anything leaves the runner", () => {
    const encrypt = workflow.indexOf("age --encrypt");
    expect(encrypt).toBeGreaterThan(0);
    for (const upload of ["aws s3api put-object", "actions/upload-artifact"]) {
      expect(workflow.indexOf(upload)).toBeGreaterThan(encrypt);
    }
  });
});
