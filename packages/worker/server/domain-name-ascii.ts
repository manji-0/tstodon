import {
  AccountId,
  type AccountIdValue,
  Hostname,
  type OutboxJob as OutboxJobValue,
} from "@tstodon/domain";
import { newEntityId } from "./ids";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { parseRows, runD1, runD1Batch, type RepositoryError } from "./d1";
import {
  advanceBackfillCursor as advanceBackfillCursorSql,
  readBackfillCursor as readBackfillCursorSql,
} from "./generated/prisma/sql";
import { d1PrepareTyped, queryTyped } from "./typed-sql";

/** The `backfill_cursors` row migration 0164 seeds: the last stored domain read. */
const CURSOR = "domain_name_ascii";

/** Domains read per page; a page is one batch of 12 statements, whatever its size. */
export const DOMAIN_NAME_ASCII_PAGE = 200;

/** A stored domain with a character outside printable ASCII: only these can change. */
const NON_ASCII = "*[^ -~]*";

const CursorRow = z.object({ after_id: z.string(), completed_at: z.string().nullable() });
const NameRow = z.object({ name: z.string() });

const namesOf = (table: string): string =>
  `SELECT name FROM (
     SELECT DISTINCT domain AS name FROM ${table}
     WHERE domain > ?1 AND domain GLOB ?2 ORDER BY name LIMIT ?3)`;

/** The next non-ASCII domains after the cursor, across every table that stores one typed by a person. */
const LIST_NAMES = `
SELECT name FROM (
  ${namesOf("domain_blocks")}
  UNION ${namesOf("account_domain_blocks")}
  UNION ${namesOf("domain_allows")}
  UNION ${namesOf("email_domain_blocks")}
) ORDER BY name LIMIT ?3`;

const OLD = "json_extract(e.value, '$[0]')";
const NEW = "json_extract(e.value, '$[1]')";
const OLD_NAMES = `(SELECT ${OLD} FROM json_each(?1) e)`;

/**
 * Rename a table keyed by `id` with a unique `domain`: an old row whose new
 * name is stored already is merged into that row (`merge`, the assignments
 * from the old row `o` onto the kept row) and deleted; the others are renamed.
 */
const renameKeyed = (table: string, columns: string, merge: string): ReadonlyArray<string> => [
  `UPDATE ${table} AS a SET ${merge}
   FROM (SELECT ${NEW} AS new_domain, ${columns} FROM json_each(?1) e JOIN ${table} d ON d.domain = ${OLD}) AS o
   WHERE a.domain = o.new_domain`,
  `DELETE FROM ${table} AS o WHERE o.domain IN ${OLD_NAMES} AND EXISTS (
     SELECT 1 FROM json_each(?1) e JOIN ${table} a ON a.domain = ${NEW} WHERE ${OLD} = o.domain)`,
  `UPDATE ${table} SET domain = (SELECT ${NEW} FROM json_each(?1) e WHERE ${OLD} = ${table}.domain)
   WHERE domain IN ${OLD_NAMES}`,
];

const STRICTER_SEVERITY = `CASE
  WHEN 'suspend' IN (a.severity, o.severity) THEN 'suspend'
  WHEN 'silence' IN (a.severity, o.severity) THEN 'silence'
  ELSE 'noop' END`;

/**
 * The statements that rename `[[old, new], ...]` (bound as JSON) in every
 * table, by the merge rules of migration 0164. Each takes the pairs as its
 * one parameter.
 */
const RENAMES: ReadonlyArray<string> = [
  // The strictest of the two rules; the kept row's comments, else the old one's.
  ...renameKeyed(
    "domain_blocks",
    "d.severity, d.reject_media, d.reject_reports, d.obfuscate, d.private_comment, d.public_comment, d.created_at",
    `severity = ${STRICTER_SEVERITY},
     reject_media = max(a.reject_media, o.reject_media),
     reject_reports = max(a.reject_reports, o.reject_reports),
     obfuscate = max(a.obfuscate, o.obfuscate),
     private_comment = coalesce(a.private_comment, o.private_comment),
     public_comment = coalesce(a.public_comment, o.public_comment),
     created_at = min(a.created_at, o.created_at)`,
  ),
  ...renameKeyed("domain_allows", "d.created_at", "created_at = min(a.created_at, o.created_at)"),
  ...renameKeyed(
    "email_domain_blocks",
    "d.created_at",
    "created_at = min(a.created_at, o.created_at)",
  ),
  // The renamed block keeps its id (migration 0166), which pages the list.
  `INSERT INTO account_domain_blocks (account_id, domain, created_at, id)
   SELECT r.account_id, ${NEW}, r.created_at, r.id
   FROM json_each(?1) e JOIN account_domain_blocks r ON r.domain = ${OLD}
   WHERE true
   ON CONFLICT (account_id, domain) DO UPDATE SET
     created_at = min(created_at, excluded.created_at),
     id = min(id, excluded.id)`,
  `DELETE FROM account_domain_blocks WHERE domain IN ${OLD_NAMES}`,
];

/** One page: the domains it read and renamed, and whether another page follows. */
export type DomainNameAsciiPage = Readonly<{ scanned: number; renamed: number; chained: boolean }>;

/**
 * The renames of a page, in order, up to the first domain whose ASCII form
 * an earlier one of the page takes too: both would be renamed onto one row.
 * That domain starts the next page, where it merges into the renamed row.
 */
const pageRenames = (
  names: ReadonlyArray<string>,
): Readonly<{ read: ReadonlyArray<string>; renames: ReadonlyArray<[string, string]> }> => {
  const renames: [string, string][] = [];
  const taken = new Set<string>();
  for (const [index, name] of names.entries()) {
    const ascii = Hostname.fromInput(name);
    if (ascii === undefined || ascii === name || /[^ -~]/.test(ascii)) {
      continue;
    }
    if (taken.has(ascii)) {
      return { read: names.slice(0, index), renames };
    }
    taken.add(ascii);
    renames.push([name, ascii]);
  }
  return { read: names, renames };
};

/**
 * Rename the next page of domains stored before `Hostname.fromInput` read an
 * internationalized name in its ASCII form (`bücher.example` is
 * `xn--bcher-kva.example`), in the domain blocks, a user's domain blocks,
 * the allow list and the email domain blocks, merging with a row already
 * stored under the ASCII name, and move the cursor past them. SQLite has no
 * punycode, so this runs in the Worker rather than in migration 0164. A short
 * page marks the cursor complete, after which every run reads the cursor and
 * stops. The renames and the cursor are one batch, so a repeated or
 * concurrent page leaves the same rows.
 */
export const asciiDomainNames = async (
  env: Env,
  pageSize: number = DOMAIN_NAME_ASCII_PAGE,
): Promise<Result<DomainNameAsciiPage, RepositoryError>> => {
  const db = env.DB;
  const read = await runD1(async () => {
    const cursor = (await queryTyped(db, readBackfillCursorSql(CURSOR), CursorRow))[0];
    if (cursor === undefined || cursor.completed_at !== null) {
      return undefined;
    }
    const { results } = await db
      .prepare(LIST_NAMES)
      .bind(cursor.after_id, NON_ASCII, pageSize)
      .all();
    return { afterId: cursor.after_id, names: parseRows(NameRow, results).map((row) => row.name) };
  });
  if (read.isErr()) {
    return err(read.error);
  }
  if (read.value === undefined) {
    return ok({ scanned: 0, renamed: 0, chained: false });
  }
  const { afterId, names } = read.value;
  const page = pageRenames(names);
  const cutShort = page.read.length < names.length;
  const full = names.length === pageSize || cutShort;
  const pairs = JSON.stringify(page.renames);
  const moving = page.renames.length === 0 ? ok(NOTHING_MOVING) : await movingBlocks(db, pairs);
  if (moving.isErr()) {
    return err(moving.error);
  }
  const advanced = await runD1Batch(db, [
    ...(page.renames.length === 0 ? [] : RENAMES.map((sql) => db.prepare(sql).bind(pairs))),
    d1PrepareTyped(
      db,
      advanceBackfillCursorSql(
        CURSOR,
        afterId,
        page.read.at(-1) ?? afterId,
        full ? null : nowIso(),
      ),
    ),
  ]);
  if (advanced.isErr()) {
    return err(advanced.error);
  }
  const moved = (advanced.value.at(-1)?.results ?? []).length > 0;
  if (moved) {
    await queueBlockEffects(env, moving.value);
  }
  return ok({ scanned: page.read.length, renamed: page.renames.length, chained: moved && full });
};

/** The blocks a page moves onto an ASCII name, by that name: they start applying once renamed. */
type MovingBlocks = Readonly<{
  instance: ReadonlyArray<Hostname>;
  account: ReadonlyArray<Readonly<{ accountId: AccountIdValue; domain: Hostname }>>;
}>;

const NOTHING_MOVING: MovingBlocks = { instance: [], account: [] };

const NewDomainRow = z.object({ domain: Hostname.schema });
const AccountBlockRow = z.object({ account_id: AccountId.schema, domain: Hostname.schema });

/**
 * Read, before the renames, the instance and user domain blocks they move:
 * each is renamed to its ASCII name or merged into the row stored there.
 * Remote hosts are ASCII, so a block stored in Unicode applied to no actor;
 * making it severed and cleared nothing.
 */
const movingBlocks = async (
  db: D1Database,
  pairs: string,
): Promise<Result<MovingBlocks, RepositoryError>> =>
  runD1(async () => {
    const [instance, account] = await db.batch([
      db
        .prepare(
          `SELECT DISTINCT ${NEW} AS domain FROM json_each(?1) e JOIN domain_blocks d ON d.domain = ${OLD}`,
        )
        .bind(pairs),
      db
        .prepare(
          `SELECT DISTINCT r.account_id, ${NEW} AS domain
           FROM json_each(?1) e JOIN account_domain_blocks r ON r.domain = ${OLD}`,
        )
        .bind(pairs),
    ]);
    return {
      instance: parseRows(NewDomainRow, instance?.results).map((row) => row.domain),
      account: parseRows(AccountBlockRow, account?.results).map((row) => ({
        accountId: row.account_id,
        domain: row.domain,
      })),
    };
  });

/**
 * Queue what making each moved block does, now that it applies: an instance
 * block's media clear and severance (`ApplyDomainBlockEffects`, from its row
 * as it stands), and a user block's severance of the account's follows
 * there (`SeverBlockedDomainFollows`). Each finds nothing it already did, so
 * a block merged into one that applied already severs nothing again. The
 * renames are committed when this runs, and a page renames a row once.
 */
const queueBlockEffects = async (env: Env, moving: MovingBlocks): Promise<void> => {
  const jobs: OutboxJobValue[] = [
    ...moving.instance.map((domain): OutboxJobValue => ({
      kind: "ApplyDomainBlockEffects",
      domain,
    })),
    ...moving.account.map(({ accountId, domain }): OutboxJobValue => ({
      kind: "SeverBlockedDomainFollows",
      accountId,
      domain,
      eventId: newEntityId(),
      afterActorUri: "",
    })),
  ];
  for (const job of jobs) {
    try {
      await env.OUTBOX_PROCESS_QUEUE.send(job);
    } catch {
      console.error(
        JSON.stringify({
          kind: "AsciiDomainEffectsNotQueued",
          job: job.kind,
          domain: "domain" in job ? job.domain : undefined,
        }),
      );
    }
  }
};
