import {
  type OutboxJob,
  RemoteActor,
  type RemoteEmoji,
  type RemoteStatusValue,
} from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { mediaRejectedDomains } from "./admin-domain-block-store";
import { nowIso } from "./clock";
import { parseRows, runD1, type RepositoryError } from "./d1";
import { measureJobPage } from "./metrics";
import { undeclaredShortcodes } from "./remote-emoji-document";

/**
 * A remote server's custom emoji whose image changes, as Mastodon v4.7.5
 * handles one. Mastodon keeps one `CustomEmoji` per shortcode and domain and
 * renders every post and profile of the domain with it (`from_text`), so a
 * new image shows on old posts too. `process_emoji` (`Create`,
 * `ProcessStatusUpdateService#update_emojis!`, `ProcessAccountService`)
 * fetches the image again when a tag names another URL than the stored one,
 * and skips a domain whose media is rejected (`skip_download?`).
 *
 * tstodon keeps a copy of each emoji with the post, version or profile that
 * names it. `remote_custom_emojis` (migration 0170) holds the image last read
 * for each; a document that names another image replaces it unless it is
 * dated before the stored one, so a late or retried delivery does not bring
 * back a replaced image (Mastodon keeps its stored file when the new one
 * does not download). Each replacement moves the domain to a new generation
 * (a trigger), and one `RefreshRemoteEmoji` chain per generation brings the
 * domain's copies to the stored images. A post or profile that writes a
 * shortcode it does not declare gets a copy of the domain's emoji stored
 * then; one first stored later is not added to it.
 */

type RefreshJob = Extract<OutboxJob, { kind: "RefreshRemoteEmoji" }>;
type Cursor = RefreshJob["cursor"];

/** Statuses one page reads. */
const STATUS_PAGE = 200;

/** Profiles one page reads. */
const PROFILE_PAGE = 200;

/** Domains one hourly run starts a chain for. */
const RESUME_SCAN = 20;

/** How long a chain may go without running a page before the hourly cron starts another. */
const STALLED_MS = 60 * 60 * 1000;

const START: Cursor = {
  kind: "Statuses",
  afterUsername: "",
  afterRowId: 0,
  afterActorUri: "",
  afterStatusId: "",
};

/**
 * SQL for the emoji list at `path` of `column`, each emoji of domain `domain`
 * (an SQL expression) with the image `remote_custom_emojis` holds for it.
 */
const refreshedSql = (column: string, path: string, domain: string): string =>
  `json_set(${column}, '${path}', json((
     SELECT json_group_array(json(CASE
       WHEN r.image_url IS NULL THEN e.value
       ELSE json_set(e.value, '$.url', r.image_url)
     END))
     FROM json_each(${column}, '${path}') e
     LEFT JOIN remote_custom_emojis r
       ON r.domain = ${domain} AND r.shortcode = json_extract(e.value, '$.shortcode')
   )))`;

/** SQL that holds when the emoji list at `path` of `column` shows an emoji of `domain` with another image. */
const staleSql = (column: string, path: string, domain: string): string =>
  `EXISTS (
     SELECT 1 FROM json_each(${column}, '${path}') e
     JOIN remote_custom_emojis r
       ON r.domain = ${domain} AND r.shortcode = json_extract(e.value, '$.shortcode')
     WHERE json_extract(e.value, '$.url') IS NOT r.image_url
   )`;

const statusesRefreshSql = (ids: string, domain: string): string =>
  `UPDATE remote_statuses SET emojis_json = ${refreshedSql("emojis_json", "$", domain)}
   WHERE id IN (${ids}) AND ${staleSql("emojis_json", "$", domain)}`;

const editsRefreshSql = (ids: string, domain: string): string =>
  `UPDATE remote_status_edits SET snapshot_json = ${refreshedSql("snapshot_json", "$.emojis", domain)}
   WHERE status_id IN (${ids}) AND ${staleSql("snapshot_json", "$.emojis", domain)}`;

const profilesRefreshSql = (actorUris: string, domain: string): string =>
  `UPDATE remote_actors SET profile_json = ${refreshedSql("profile_json", "$.emojis", domain)}
   WHERE actor_uri IN (${actorUris}) AND ${staleSql("profile_json", "$.emojis", domain)}`;

/**
 * SQL that adds to the emoji list at `path` of `column` each emoji of domain
 * `domain` that the JSON list `shortcodes` names and the list does not hold,
 * with the image `remote_custom_emojis` holds for it.
 */
const addedSql = (column: string, path: string, domain: string, shortcodes: string) => {
  const known = `SELECT r.shortcode, r.image_url
     FROM json_each(${shortcodes}) w
     JOIN remote_custom_emojis r ON r.domain = ${domain} AND r.shortcode = w.value
     WHERE NOT EXISTS (
       SELECT 1 FROM json_each(${column}, '${path}') e
       WHERE json_extract(e.value, '$.shortcode') = w.value
     )`;
  return {
    set: `json_set(${column}, '${path}', json((
       SELECT json_group_array(json(v)) FROM (
         SELECT e.value AS v FROM json_each(${column}, '${path}') e
         UNION ALL
         SELECT json_object('shortcode', k.shortcode, 'url', k.image_url) FROM (${known}) k
       ))))`,
    when: `EXISTS (${known})`,
  };
};

const statusAddedSql = (id: string, domain: string, shortcodes: string): string => {
  const added = addedSql("emojis_json", "$", domain, shortcodes);
  return `UPDATE remote_statuses SET emojis_json = ${added.set} WHERE id = ${id} AND ${added.when}`;
};

const profileAddedSql = (actorUri: string, domain: string, shortcodes: string): string => {
  const added = addedSql("profile_json", "$.emojis", domain, shortcodes);
  return `UPDATE remote_actors SET profile_json = ${added.set}
    WHERE actor_uri = ${actorUri} AND ${added.when}`;
};

/** Where the document a recorded emoji came from is kept, to show the stored images. */
export type EmojiSource =
  | Readonly<{ kind: "Status"; statusId: string }>
  | Readonly<{ kind: "Profile" }>;

/** The custom emoji a note or a profile writes. */
export type WrittenEmojis = Readonly<{
  /** Those its `Emoji` tags declare. */
  declared: ReadonlyArray<RemoteEmoji>;
  /** The shortcodes it writes without declaring them (`undeclaredShortcodes`). */
  undeclared: ReadonlyArray<string>;
}>;

/**
 * Store the images `actor`'s note or profile declares for its domain's
 * emoji, as `process_emoji` does, and show the stored images in that note
 * (with its earlier versions) or profile. A tag without `updated` is dated
 * `dated`. The note or profile also shows each emoji of the domain stored
 * here that it writes without declaring, as Mastodon renders every emoji
 * `CustomEmoji.from_text` finds for the author's domain. Best effort, as the
 * document is stored already: a failure is logged.
 */
export const recordRemoteEmojiImages = async (
  db: D1Database,
  actor: RemoteActor,
  { declared, undeclared }: WrittenEmojis,
  dated: string,
  source: EmojiSource,
): Promise<void> => {
  const recording =
    declared.length > 0 && !RemoteActor.onAnyHost(actor, await mediaRejectedDomains(db));
  if (!recording && undeclared.length === 0) {
    return;
  }
  const domain = "(SELECT domain FROM remote_actors WHERE actor_uri = ?1)";
  const shortcodes = JSON.stringify(undeclared);
  const record = recording
    ? [
        db
          .prepare(
            `INSERT INTO remote_custom_emojis (domain, shortcode, image_url, updated_at)
             SELECT a.domain, json_extract(e.value, '$.shortcode'), json_extract(e.value, '$.url'),
               coalesce(json_extract(e.value, '$.updated'), ?3)
             FROM remote_actors a, json_each(?2) e WHERE a.actor_uri = ?1
             ON CONFLICT (domain, shortcode) DO UPDATE SET
               image_url = excluded.image_url,
               updated_at = excluded.updated_at
             WHERE excluded.image_url IS NOT image_url AND excluded.updated_at >= updated_at`,
          )
          .bind(actor.actorUri, JSON.stringify(declared), dated),
        ...(source.kind === "Status"
          ? [
              db.prepare(statusesRefreshSql("?2", domain)).bind(actor.actorUri, source.statusId),
              db.prepare(editsRefreshSql("?2", domain)).bind(actor.actorUri, source.statusId),
            ]
          : [db.prepare(profilesRefreshSql("?1", domain)).bind(actor.actorUri)]),
      ]
    : [];
  const add =
    undeclared.length === 0
      ? []
      : [
          source.kind === "Status"
            ? db
                .prepare(statusAddedSql("?2", domain, "?3"))
                .bind(actor.actorUri, source.statusId, shortcodes)
            : db.prepare(profileAddedSql("?1", domain, "?2")).bind(actor.actorUri, shortcodes),
        ];
  const recorded = await runD1(async () => {
    await db.batch([...record, ...add]);
  });
  if (recorded.isErr()) {
    console.error(
      JSON.stringify({
        kind: "RemoteEmojisNotRecorded",
        actorUri: actor.actorUri,
        error: recorded.error.message,
      }),
    );
  }
};

/**
 * {@link recordRemoteEmojiImages} for a note `actor` wrote, stored as
 * `status`, then {@link startRemoteEmojiRefresh}. A tag without `updated` is
 * dated as the note's last edit, else its publication.
 */
export const recordNoteEmojis = async (
  env: Env,
  actor: RemoteActor,
  status: Pick<
    RemoteStatusValue,
    "id" | "emojis" | "publishedAt" | "editedAt" | "contentHtml" | "spoilerText" | "poll"
  >,
): Promise<void> => {
  // As `Status#emojis`: the spoiler, the text and the poll's options.
  const undeclared = undeclaredShortcodes(
    [
      status.spoilerText,
      status.contentHtml,
      ...(status.poll.kind === "NoPoll" ? [] : status.poll.options.map((option) => option.title)),
    ],
    status.emojis,
  );
  const dated = status.editedAt.kind === "Edited" ? status.editedAt.at : status.publishedAt;
  await recordRemoteEmojiImages(env.DB, actor, { declared: status.emojis, undeclared }, dated, {
    kind: "Status",
    statusId: status.id,
  });
  if (status.emojis.length > 0) {
    await startRemoteEmojiRefresh(env, actor.actorUri);
  }
};

/** What {@link startRemoteEmojiRefresh} reads and queues on. */
export type EmojiRefreshBindings = Pick<Env, "DB" | "OUTBOX_PROCESS_QUEUE">;

/**
 * {@link recordRemoteEmojiImages} for the profile of `actor` as its document
 * was just read, by a fetch or from its own `Update`, as
 * `ProcessAccountService#process_emojis` on every fetch of an account; then
 * {@link startRemoteEmojiRefresh}, so an image it changes shows on the
 * domain's posts at once. A tag without `updated` is dated as the fetch.
 */
export const recordProfileEmojis = async (
  stores: EmojiRefreshBindings,
  actor: RemoteActor,
): Promise<void> => {
  const { profile } = actor;
  // As `Account#emojifiable_text`: the note, the name, the fields' names and values.
  const undeclared = undeclaredShortcodes(
    [
      profile.note,
      actor.displayName,
      ...profile.fields.map((field) => field.name),
      ...profile.fields.map((field) => field.value),
    ],
    profile.emojis,
  );
  await recordRemoteEmojiImages(
    stores.DB,
    actor,
    { declared: profile.emojis, undeclared },
    actor.fetchedAt,
    { kind: "Profile" },
  );
  if (profile.emojis.length > 0) {
    await startRemoteEmojiRefresh(stores, actor.actorUri);
  }
};

const Claimed = z.object({ domain: z.string(), generation: z.number() });

const refreshJob = ({ domain, generation }: z.infer<typeof Claimed>): RefreshJob => ({
  kind: "RefreshRemoteEmoji",
  domain,
  generation,
  cursor: START,
});

/**
 * Start the refresh of `actorUri`'s domain when an image of it was replaced
 * since its last chain started; one chain per replacement, however many
 * documents name it. A chain that cannot be queued is left to the hourly
 * cron. Best effort: a failure is logged.
 */
export const startRemoteEmojiRefresh = async (
  env: EmojiRefreshBindings,
  actorUri: string,
): Promise<void> => {
  const claimed = await runD1(async () => {
    const { results } = await env.DB.prepare(
      `UPDATE remote_emoji_refreshes SET queued_generation = generation, queued_at = ?2
       WHERE domain = (SELECT domain FROM remote_actors WHERE actor_uri = ?1)
         AND queued_generation < generation
       RETURNING domain, generation`,
    )
      .bind(actorUri, nowIso())
      .all();
    return parseRows(Claimed, results);
  });
  if (claimed.isErr()) {
    console.error(JSON.stringify({ kind: "RemoteEmojiRefreshNotStarted", actorUri }));
    return;
  }
  for (const claim of claimed.value) {
    try {
      await env.OUTBOX_PROCESS_QUEUE.send(refreshJob(claim));
    } catch {
      console.error(JSON.stringify({ kind: "JobNotQueued", jobKind: "RefreshRemoteEmoji" }));
      await env.DB.prepare(
        `UPDATE remote_emoji_refreshes SET queued_generation = ?2 - 1
         WHERE domain = ?1 AND queued_generation = ?2`,
      )
        .bind(claim.domain, claim.generation)
        .run()
        .catch(() => undefined);
    }
  }
};

/**
 * The statuses of domain `?1` after the cursor, `?6` of them: the rest of
 * the actor `?4` after status `?5`, then those of the actors after
 * `(username, rowid)` `(?2, ?3)`. Each part reads its rows in index order.
 */
const STATUS_PAGE_SQL = `SELECT username, row_id, actor_uri, id FROM (
    SELECT * FROM (
      SELECT a.username, a.rowid AS row_id, s.actor_uri, s.id
      FROM remote_actors a JOIN remote_statuses s ON s.actor_uri = a.actor_uri
      WHERE a.domain = ?1 AND a.actor_uri = ?4 AND s.id > ?5
      ORDER BY s.id LIMIT ?6
    )
    UNION ALL
    SELECT * FROM (
      SELECT a.username, a.rowid AS row_id, s.actor_uri, s.id
      FROM remote_actors a JOIN remote_statuses s ON s.actor_uri = a.actor_uri
      WHERE a.domain = ?1 AND (a.username, a.rowid) > (?2, ?3)
      ORDER BY a.username, a.rowid, s.id LIMIT ?6
    )
  ) ORDER BY username, row_id, id LIMIT ?6`;

const StatusPageRow = z.object({
  username: z.string(),
  row_id: z.number(),
  actor_uri: z.string(),
  id: z.string(),
});

/** The actors of domain `?1` after `(username, rowid)` `(?2, ?3)`, `?4` of them, in index order. */
const PROFILE_PAGE_SQL = `SELECT rowid AS row_id, username, actor_uri FROM remote_actors
  WHERE domain = ?1 AND (username, rowid) > (?2, ?3)
  ORDER BY username, rowid LIMIT ?4`;

const ProfilePageRow = z.object({
  row_id: z.number(),
  username: z.string(),
  actor_uri: z.string(),
});

/**
 * Refresh the page after `cursor` and say that this chain ran. Resolves to
 * the cursor after the page, `undefined` once the profiles are read.
 */
const refreshPage = (
  db: D1Database,
  job: RefreshJob,
): Promise<Result<Cursor | undefined, RepositoryError>> =>
  runD1(async () => {
    const heartbeat = db
      .prepare(
        `UPDATE remote_emoji_refreshes SET queued_at = ?3
         WHERE domain = ?1 AND queued_generation = ?2`,
      )
      .bind(job.domain, job.generation, nowIso());
    const { cursor } = job;
    if (cursor.kind === "Statuses") {
      const binds = [
        job.domain,
        cursor.afterUsername,
        cursor.afterRowId,
        cursor.afterActorUri,
        cursor.afterStatusId,
        STATUS_PAGE,
      ];
      const ids = `SELECT id FROM (${STATUS_PAGE_SQL})`;
      const [, , , read] = await db.batch([
        heartbeat,
        db.prepare(statusesRefreshSql(ids, "?1")).bind(...binds),
        db.prepare(editsRefreshSql(ids, "?1")).bind(...binds),
        db.prepare(STATUS_PAGE_SQL).bind(...binds),
      ]);
      const last = parseRows(StatusPageRow, read?.results).at(STATUS_PAGE - 1);
      return last === undefined
        ? { kind: "Profiles", afterUsername: "", afterRowId: 0 }
        : {
            kind: "Statuses",
            afterUsername: last.username,
            afterRowId: last.row_id,
            afterActorUri: last.actor_uri,
            afterStatusId: last.id,
          };
    }
    const binds = [job.domain, cursor.afterUsername, cursor.afterRowId, PROFILE_PAGE];
    const [, , read] = await db.batch([
      heartbeat,
      db
        .prepare(profilesRefreshSql(`SELECT actor_uri FROM (${PROFILE_PAGE_SQL})`, "?1"))
        .bind(...binds),
      db.prepare(PROFILE_PAGE_SQL).bind(...binds),
    ]);
    const last = parseRows(ProfilePageRow, read?.results).at(PROFILE_PAGE - 1);
    if (last !== undefined) {
      return { kind: "Profiles", afterUsername: last.username, afterRowId: last.row_id };
    }
    await db
      .prepare(
        `UPDATE remote_emoji_refreshes SET refreshed_generation = ?2
         WHERE domain = ?1 AND generation = ?2`,
      )
      .bind(job.domain, job.generation)
      .run();
    return undefined;
  });

const Generation = z.object({ generation: z.number() });

/**
 * Run one page of a domain's refresh and queue the next, unless a newer
 * generation of the domain's images exists: its own chain refreshes the
 * domain. A retry runs the same page again, which rewrites only the copies
 * that differ from the stored images.
 */
export const processRefreshRemoteEmojiJob = (env: Env, job: RefreshJob) =>
  measureJobPage(env, job.kind, async () => {
    const current = await runD1(async () =>
      parseRows(
        Generation,
        (
          await env.DB.prepare("SELECT generation FROM remote_emoji_refreshes WHERE domain = ?")
            .bind(job.domain)
            .all()
        ).results,
      ),
    );
    if (current.isErr()) {
      return { outcome: "retry", size: 0, chained: false };
    }
    if (current.value[0]?.generation !== job.generation) {
      return { outcome: "ok", size: 0, chained: false, step: "Superseded" };
    }
    const next = await refreshPage(env.DB, job);
    if (next.isErr()) {
      return { outcome: "retry", size: 0, chained: false };
    }
    if (next.value !== undefined) {
      await env.OUTBOX_PROCESS_QUEUE.send({ ...job, cursor: next.value });
    }
    return {
      outcome: "ok",
      size: -1,
      chained: next.value !== undefined,
      step: job.cursor.kind,
    };
  });

/**
 * Start a chain for each domain whose newest images have none, because it
 * could not be queued, or whose chain ran no page for an hour (hourly cron).
 */
export const processResumeRemoteEmojiRefreshesJob = (env: Env) =>
  measureJobPage(env, "ResumeRemoteEmojiRefreshes", async () => {
    const now = Date.parse(nowIso());
    const claimed = await runD1(async () => {
      const { results } = await env.DB.prepare(
        `UPDATE remote_emoji_refreshes SET queued_generation = generation, queued_at = ?1
         WHERE domain IN (
           SELECT domain FROM remote_emoji_refreshes
           WHERE refreshed_generation < generation
             AND (queued_generation < generation OR queued_at IS NULL OR queued_at < ?2)
           LIMIT ?3
         )
         RETURNING domain, generation`,
      )
        .bind(new Date(now).toISOString(), new Date(now - STALLED_MS).toISOString(), RESUME_SCAN)
        .all();
      return parseRows(Claimed, results);
    });
    if (claimed.isErr()) {
      return { outcome: "retry", size: -1, chained: false };
    }
    if (claimed.value.length > 0) {
      await env.OUTBOX_PROCESS_QUEUE.sendBatch(
        claimed.value.map((claim) => ({ body: refreshJob(claim) })),
      );
    }
    return { outcome: "ok", size: claimed.value.length, chained: claimed.value.length > 0 };
  });
