import type { OutboxJob, RemoteEmoji } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { parseRows, runD1, type RepositoryError } from "./d1";
import { startJob } from "./inline-job";
import { measureJobPage } from "./metrics";

/**
 * A remote server's custom emoji whose image changes, as Mastodon v4.7.5
 * handles one. Mastodon keeps one `CustomEmoji` per shortcode and domain and
 * renders every post and profile of the domain with it (`from_text`), so a
 * new image shows on old posts too. `process_emoji` (`Create`,
 * `ProcessStatusUpdateService#update_emojis!`, `ProcessAccountService`)
 * fetches the image again when a tag names another URL than the stored one.
 * A newer `updated` with the same URL fetches nothing while the image is
 * stored, and tstodon stores no remote image, so it is not read.
 *
 * tstodon keeps a copy of each emoji with the post, version or profile that
 * names it. `remote_custom_emojis` (migration 0170) holds the image last
 * read for each, and a replacement queues {@link processRefreshRemoteEmojiJob}
 * to bring the copies of the domain's actors to it.
 */

type RefreshJob = Extract<OutboxJob, { kind: "RefreshRemoteEmoji" }>;

/** Actors one page brings up to date. */
const PAGE = 50;

const START: RefreshJob["cursor"] = { afterUsername: "", afterRowId: 0 };

const Replaced = z.object({ domain: z.string(), shortcode: z.string(), revision: z.number() });

/**
 * Store the images `actorUri`'s note or profile names for its domain's
 * emoji, and refresh every copy of each emoji whose image this replaced. An
 * emoji first seen here is stored as it is; the copies already stored keep
 * theirs until it is replaced.
 */
export const recordRemoteEmojis = async (
  env: Env,
  actorUri: string,
  emojis: ReadonlyArray<RemoteEmoji>,
): Promise<Result<void, RepositoryError>> => {
  const replaced = await runD1(async () => {
    if (emojis.length === 0) {
      return [];
    }
    const { results } = await env.DB.prepare(
      `INSERT INTO remote_custom_emojis (domain, shortcode, image_url, updated_at)
       SELECT a.domain, json_extract(e.value, '$.shortcode'), json_extract(e.value, '$.url'), ?3
       FROM remote_actors a, json_each(?2) e WHERE a.actor_uri = ?1
       ON CONFLICT (domain, shortcode) DO UPDATE SET
         image_url = excluded.image_url,
         revision = revision + 1,
         updated_at = excluded.updated_at
       WHERE image_url IS NOT excluded.image_url
       RETURNING domain, shortcode, revision`,
    )
      .bind(actorUri, JSON.stringify(emojis), nowIso())
      .all();
    return parseRows(Replaced, results).filter((row) => row.revision > 0);
  });
  if (replaced.isOk()) {
    for (const { domain, shortcode } of replaced.value) {
      await startJob(
        env,
        { kind: "RefreshRemoteEmoji", domain, shortcode, cursor: START },
        processRefreshRemoteEmojiJob,
        "Queued",
      );
    }
  }
  return replaced.map(() => undefined);
};

/**
 * SQL for the emoji list at `path` of `column` with the image of emoji `?2`
 * of domain `?1` as `remote_custom_emojis` holds it.
 */
const refreshedSql = (column: string, path: string): string =>
  `json_set(${column}, '${path}', json((
     SELECT json_group_array(json(CASE
       WHEN json_extract(e.value, '$.shortcode') = ?2 THEN json_set(e.value, '$.url', r.image_url)
       ELSE e.value
     END))
     FROM json_each(${column}, '${path}') e, remote_custom_emojis r
     WHERE r.domain = ?1 AND r.shortcode = ?2
   )))`;

/** SQL that holds when the emoji list at `path` of `column` shows emoji `?2` with another image. */
const staleSql = (column: string, path: string): string =>
  `instr(${column}, ?2) > 0 AND EXISTS (
     SELECT 1 FROM json_each(${column}, '${path}') e, remote_custom_emojis r
     WHERE r.domain = ?1 AND r.shortcode = ?2
       AND json_extract(e.value, '$.shortcode') = ?2
       AND json_extract(e.value, '$.url') IS NOT r.image_url
   )`;

/** The actors of domain `?1` after the cursor `(?3, ?4)`, `?5` of them, in the order its index holds them. */
const PAGE_SQL = `SELECT rowid AS row_id, username, actor_uri FROM remote_actors
  WHERE domain = ?1 AND (username, rowid) > (?3, ?4)
  ORDER BY username, rowid LIMIT ?5`;

const PageRow = z.object({ row_id: z.number(), username: z.string(), actor_uri: z.string() });

/**
 * Bring the posts, earlier versions and profiles of the page of actors after
 * `cursor` to the emoji's current image. Resolves to the cursor after the
 * page, `undefined` once the domain's last actor is read.
 */
const refreshPage = (
  db: D1Database,
  job: RefreshJob,
): Promise<Result<RefreshJob["cursor"] | undefined, RepositoryError>> =>
  runD1(async () => {
    const { afterUsername, afterRowId } = job.cursor;
    const binds = [job.domain, job.shortcode, afterUsername, afterRowId, PAGE];
    const actors = `SELECT actor_uri FROM (${PAGE_SQL})`;
    const [, , , read] = await db.batch([
      db
        .prepare(
          `UPDATE remote_statuses SET emojis_json = ${refreshedSql("emojis_json", "$")}
           WHERE actor_uri IN (${actors}) AND ${staleSql("emojis_json", "$")}`,
        )
        .bind(...binds),
      db
        .prepare(
          `UPDATE remote_status_edits SET snapshot_json = ${refreshedSql("snapshot_json", "$.emojis")}
           WHERE status_id IN (SELECT id FROM remote_statuses WHERE actor_uri IN (${actors}))
             AND ${staleSql("snapshot_json", "$.emojis")}`,
        )
        .bind(...binds),
      db
        .prepare(
          `UPDATE remote_actors SET profile_json = ${refreshedSql("profile_json", "$.emojis")}
           WHERE actor_uri IN (${actors}) AND ${staleSql("profile_json", "$.emojis")}`,
        )
        .bind(...binds),
      db.prepare(PAGE_SQL).bind(...binds),
    ]);
    const rows = parseRows(PageRow, read?.results);
    const last = rows.at(-1);
    return last !== undefined && rows.length === PAGE
      ? { afterUsername: last.username, afterRowId: last.row_id }
      : undefined;
  });

/**
 * Run one page of a refresh and queue the next. Each page writes the image
 * the emoji has as it runs, so a retry, a second job for the same emoji, or
 * a replacement while the chain runs converges on the latest image.
 */
export const processRefreshRemoteEmojiJob = (env: Env, job: RefreshJob) =>
  measureJobPage(env, job.kind, async () => {
    const next = await refreshPage(env.DB, job);
    if (next.isErr()) {
      return { outcome: "retry", size: 0, chained: false };
    }
    if (next.value !== undefined) {
      await env.OUTBOX_PROCESS_QUEUE.send({ ...job, cursor: next.value });
    }
    return { outcome: "ok", size: -1, chained: next.value !== undefined };
  });
