#!/usr/bin/env node
// Naming and retention for the scheduled D1 backups
// (.github/workflows/d1-backup.yml, docs/operations/runbook.md#scheduled-d1-backups).
//
//   node scripts/d1-backup.mjs key --prefix d1/ --database tstodon [--at <ISO time>]
//     prints the object key for a backup taken now (or at --at).
//   node scripts/d1-backup.mjs prune --prefix d1/ --database tstodon \
//       [--keep-days 35] [--keep-months 12] [--keep-latest 7] [--now <ISO time>] < keys
//     reads object keys (one per line) and prints the ones the retention
//     policy lets go, one per line. Keys it does not recognise are never printed.
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const BACKUP_SUFFIX = ".sql.gz.age";

const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (value, width = 2) => String(value).padStart(width, "0");

/** `20261109T034312Z` for a date (UTC, second precision). */
export const backupStamp = (date) =>
  `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
  `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;

/** The object key of the backup of `database` taken at `date`. */
export const backupKey = (prefix, database, date) =>
  `${prefix}${database}-${backupStamp(date)}${BACKUP_SUFFIX}`;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * When the backup under `key` was taken, or `undefined` when `key` is not a
 * backup of `database` under `prefix` (another file, another database, a
 * malformed or impossible stamp).
 */
export const parseBackupKey = (prefix, database, key) => {
  const pattern = new RegExp(
    `^${escapeRegExp(prefix)}${escapeRegExp(database)}-(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})Z${escapeRegExp(BACKUP_SUFFIX)}$`,
  );
  const match = pattern.exec(key);
  if (!match) {
    return undefined;
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC rolls 20261340 over into another month; refuse it instead.
  return backupStamp(date) === match.slice(1, 4).join("") + "T" + match.slice(4).join("") + "Z"
    ? date
    : undefined;
};

const monthIndex = (date) => date.getUTCFullYear() * 12 + date.getUTCMonth();

/**
 * The backups the retention policy lets go. Kept:
 * - every backup younger than `keepDays` days;
 * - the first backup of each calendar month (UTC) for the current month and
 *   the `keepMonths - 1` before it;
 * - the newest `keepLatest` backups whatever their age, so a schedule that
 *   stopped running never prunes the last good copies away.
 * Keys that are not backups of `database` under `prefix` are never returned.
 */
export const selectPrunable = (
  keys,
  { prefix, database, now, keepDays = 35, keepMonths = 12, keepLatest = 7 },
) => {
  const backups = [...new Set(keys)]
    .map((key) => ({ key, takenAt: parseBackupKey(prefix, database, key) }))
    .filter((backup) => backup.takenAt !== undefined)
    .sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime() || a.key.localeCompare(b.key));
  const keep = new Set();
  for (const backup of backups.slice(Math.max(0, backups.length - keepLatest))) {
    keep.add(backup.key);
  }
  const seenMonths = new Set();
  for (const backup of backups) {
    const month = monthIndex(backup.takenAt);
    if (!seenMonths.has(month)) {
      seenMonths.add(month);
      if (monthIndex(now) - month < keepMonths) {
        keep.add(backup.key);
      }
    }
    if (now.getTime() - backup.takenAt.getTime() < keepDays * DAY_MS) {
      keep.add(backup.key);
    }
  }
  return backups.filter((backup) => !keep.has(backup.key)).map((backup) => backup.key);
};

const nonNegativeInteger = (name, value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
};

const dateOption = (name, value) => {
  if (value === undefined) {
    return new Date();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`--${name} must be an ISO date, got ${JSON.stringify(value)}`);
  }
  return date;
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const DATABASE_NAME = /^[A-Za-z0-9_-]+$/;

const main = async (argv) => {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      prefix: { type: "string", default: "d1/" },
      database: { type: "string", default: "tstodon" },
      at: { type: "string" },
      now: { type: "string" },
      "keep-days": { type: "string", default: "35" },
      "keep-months": { type: "string", default: "12" },
      "keep-latest": { type: "string", default: "7" },
    },
  });
  if (!DATABASE_NAME.test(values.database)) {
    throw new Error(
      `--database must match ${DATABASE_NAME}, got ${JSON.stringify(values.database)}`,
    );
  }
  const [command] = positionals;
  if (command === "key") {
    process.stdout.write(
      `${backupKey(values.prefix, values.database, dateOption("at", values.at))}\n`,
    );
    return;
  }
  if (command === "prune") {
    const keys = (await readStdin())
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const prunable = selectPrunable(keys, {
      prefix: values.prefix,
      database: values.database,
      now: dateOption("now", values.now),
      keepDays: nonNegativeInteger("keep-days", values["keep-days"]),
      keepMonths: nonNegativeInteger("keep-months", values["keep-months"]),
      keepLatest: Math.max(1, nonNegativeInteger("keep-latest", values["keep-latest"])),
    });
    process.stdout.write(prunable.map((key) => `${key}\n`).join(""));
    return;
  }
  throw new Error(`usage: d1-backup.mjs key|prune [options] (got ${JSON.stringify(command)})`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
