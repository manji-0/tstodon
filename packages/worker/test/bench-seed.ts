import { env } from "cloudflare:test";
import { generateAccountKeys } from "../server/keys";

/**
 * Seeds the benchmark dataset (`perf.bench.test.ts`) straight into D1 with
 * recursive-CTE `INSERT ... SELECT` statements, so half a million statuses
 * take seconds, not the hours the API would. The schema's triggers keep
 * `account_stats` and `status_stats` as the API would leave them.
 *
 * Every relation is a deterministic function of row numbers, so two runs
 * (or two branches) read the same data. `scale` multiplies every count; 1 is
 * the full dataset described in `docs/architecture/d1-heavy-scenarios.md#benchmark`.
 */

export type BenchShape = Readonly<{
  localAccounts: number;
  remoteActors: number;
  remoteDomains: number;
  localStatuses: number;
  remoteStatuses: number;
  /** Local accounts each local account follows, besides the celebrity. */
  followsPerAccount: number;
  /** Remote actors each local account follows. */
  remoteFollowsPerAccount: number;
  /** Local accounts following the hot remote actor. */
  hotActorFollowers: number;
  favourites: number;
  viewerNotifications: number;
  otherNotifications: number;
  /** Accounts that own two lists of `listMembers` local accounts each. */
  listOwners: number;
  listMembers: number;
  /** Accounts that follow three hashtags each. */
  tagFollowers: number;
}>;

export const benchShape = (scale: number): BenchShape => {
  const n = (full: number, least: number) => Math.max(least, Math.round(full * scale));
  return {
    localAccounts: n(2_000, 60),
    remoteActors: n(20_000, 200),
    remoteDomains: n(400, 10),
    localStatuses: n(200_000, 2_000),
    remoteStatuses: n(300_000, 3_000),
    followsPerAccount: Math.min(100, n(2_000, 60) - 3),
    remoteFollowsPerAccount: 50,
    hotActorFollowers: n(1_500, 40),
    favourites: n(300_000, 3_000),
    viewerNotifications: n(10_000, 200),
    otherNotifications: n(100_000, 1_000),
    listOwners: n(500, 10),
    listMembers: 20,
    tagFollowers: n(1_000, 20),
  };
};

/** The accounts and objects the scenarios act as or on (1-based row numbers). */
export const VIEWER = 1;
export const CELEB = 2;
export const HOT_TAG = "benchhot";
export const HOT_ACTOR_URI = "https://hot.bench.example/users/hot";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Statuses and remote statuses fill the 30 days before the seed's clock, minus an hour. */
const SPAN = 30 * DAY;
const CHUNK = 50_000;

/** SQL text for the entity id (`server/ids.ts`) of instant `ms` with low bits `low`. */
const entityId = (ms: string, low: string) => `printf('%018d', (${ms}) * 65536 + (${low}))`;
const iso = (ms: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', (${ms}) / 1000.0, 'unixepoch')`;

export type BenchSeed = Readonly<{
  shape: BenchShape;
  /** Local account id of row number `i` (1-based). */
  accountId: (i: number) => string;
  /** Local status id of row number `n` (1-based). */
  statusId: (n: number) => string;
  /** Root of the seeded thread (60 ancestors deep chain, 240 descendants). */
  threadRoot: number;
  threadLeaf: number;
  listId: string;
  seconds: number;
}>;

export const seedBench = async (scale: number, analyze = false): Promise<BenchSeed> => {
  const started = Date.now();
  const shape = benchShape(scale);
  const L = shape.localAccounts;
  const R = shape.remoteActors;
  const D = shape.remoteDomains;
  const NL = shape.localStatuses;
  const NR = shape.remoteStatuses;
  const end = Date.now() - HOUR;
  const start = end - SPAN;
  const accountBase = Math.floor(start / 1000) * 1000 - 60 * DAY;
  const localStep = Math.floor(SPAN / NL);
  const remoteStep = Math.floor(SPAN / NR);
  const keys = await generateAccountKeys();

  const accountSql = (i: string) => entityId(`${accountBase} + (${i})`, "0");
  const localMs = (n: string) => `${start} + (${n}) * ${localStep}`;
  const remoteMs = (n: string) => `${start} + (${n}) * ${remoteStep} + 7`;
  const localSql = (n: string) => entityId(localMs(n), `(${n}) % 32768`);
  const remoteSql = (n: string) => entityId(remoteMs(n), `32768 + (${n}) % 32768`);
  const actorUri = (j: string) =>
    `'https://r' || ((${j}) % ${D}) || '.bench.example/users/a' || (${j})`;
  /** Who wrote local status n: the celebrity every 50th, else spread over every account. */
  const authorOf = (n: string) =>
    `(CASE WHEN (${n}) % 50 = 0 THEN ${CELEB} ELSE ((${n}) * 7) % ${L} + 1 END)`;
  const remoteAuthorOf = (n: string) =>
    `(CASE WHEN (${n}) % 200 = 0 THEN '${HOT_ACTOR_URI}' ELSE ${actorUri(`((${n}) * 31) % ${R} + 1`)} END)`;

  const threadRoot = NL - 4_000;
  const threadLeaf = threadRoot + 60;
  /** The parent of local status n, or NULL: a 60-deep chain under the thread root, 240 replies across it, and every tenth status otherwise. */
  const parentOf = (n: string) => `(CASE
      WHEN (${n}) > ${threadRoot} AND (${n}) <= ${threadLeaf} THEN (${n}) - 1
      WHEN (${n}) > ${threadLeaf} AND (${n}) <= ${threadLeaf + 240} THEN ${threadRoot} + ((${n}) * 7) % 60
      WHEN (${n}) % 10 = 3 AND (${n}) > 100 THEN (${n}) - 3 - (${n}) % 97
      ELSE NULL END)`;
  const isReblog = (n: string) =>
    `((${n}) % 20 = 7 AND NOT ((${n}) > ${threadRoot} AND (${n}) <= ${threadLeaf + 240}))`;

  const series = (from: number, to: number) =>
    `WITH RECURSIVE s(n) AS (SELECT ${from} UNION ALL SELECT n + 1 FROM s WHERE n < ${to})`;
  const run = async (
    label: string,
    total: number,
    statement: (from: number, to: number) => string,
  ) => {
    for (let from = 1; from <= total; from += CHUNK) {
      const to = Math.min(total, from + CHUNK - 1);
      try {
        await env.DB.prepare(statement(from, to)).run();
      } catch (error) {
        throw new Error(`bench seed ${label} [${from}, ${to}]: ${String(error)}`, { cause: error });
      }
    }
  };

  await run(
    "users",
    L,
    (from, to) => `${series(from, to)}
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role)
    SELECT 'bench-user-' || n, 'b' || n, 'b' || n || '@bench.example', 1, ${accountBase}, ${accountBase}, 'user' FROM s`,
  );
  await env.DB.prepare(
    `${series(1, L)}
    INSERT INTO accounts (id, username, access_email, display_name, public_key_pem, private_key_jwk,
      created_at, updated_at, auth_user_id, current_sign_in_at)
    SELECT ${accountSql("n")}, 'b' || n, 'b' || n || '@bench.example', 'Bench ' || n, ?, ?,
      ${iso(`${accountBase} + n * 1000`)}, ${iso(`${accountBase} + n * 1000`)}, 'bench-user-' || n,
      ${iso(`${end}`)}
    FROM s`,
  )
    .bind(keys.publicKeyPem, keys.privateKeyJwk.reveal())
    .run();

  await run(
    "remote_actors",
    R,
    (from, to) => `${series(from, to)}
    INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, shared_inbox_uri, display_name, fetched_at)
    SELECT ${actorUri("n")}, 'a' || n, 'r' || (n % ${D}) || '.bench.example', ${actorUri("n")} || '/inbox',
      'https://r' || (n % ${D}) || '.bench.example/inbox', 'Remote ' || n, ${iso(`${end}`)}
    FROM s`,
  );

  // Local follows: everyone follows the celebrity, every account follows
  // `followsPerAccount` others, spread by two co-prime strides.
  await env.DB.prepare(`${series(1, L)}
    INSERT OR IGNORE INTO follows (id, follower_account_id, target_account_id, kind, created_at)
    SELECT ${entityId(`${accountBase} + 500000 + n`, "1")}, ${accountSql("n")}, ${accountSql(`${CELEB}`)}, 'Accepted', ${iso(`${accountBase} + 500000 + n`)}
    FROM s WHERE n <> ${CELEB}`).run();
  await run(
    "follows",
    L * shape.followsPerAccount,
    (from, to) => `${series(from, to)},
    pairs(i, t, n) AS (
      SELECT (n - 1) / ${shape.followsPerAccount} + 1,
             (((n - 1) / ${shape.followsPerAccount} + 1) * 37 + ((n - 1) % ${shape.followsPerAccount} + 1) * 101) % ${L} + 1, n
      FROM s)
    INSERT OR IGNORE INTO follows (id, follower_account_id, target_account_id, kind, created_at)
    SELECT ${entityId(`${accountBase} + 1000000 + n`, "2")}, ${accountSql("i")}, ${accountSql("t")}, 'Accepted', ${iso(`${accountBase} + 1000000 + n`)}
    FROM pairs WHERE i <> t`,
  );

  // Remote follows of local accounts: every actor follows the celebrity and one other account.
  await run(
    "remote_follows",
    R,
    (from, to) => `${series(from, to)}
    INSERT OR IGNORE INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at, follow_activity_id)
    SELECT ${entityId(`${accountBase} + 2000000 + n`, "3")}, ${actorUri("n")}, ${accountSql(`${CELEB}`)}, 'Fulfilled', 'Accepted',
      ${iso(`${accountBase} + 2000000 + n`)}, ${actorUri("n")} || '#follow-celeb'
    FROM s`,
  );
  await run(
    "remote_follows_other",
    R,
    (from, to) => `${series(from, to)}
    INSERT OR IGNORE INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at, follow_activity_id)
    SELECT ${entityId(`${accountBase} + 2100000 + n`, "4")}, ${actorUri("n")}, ${accountSql(`(n * 17) % ${L} + 1`)}, 'Fulfilled', 'Accepted',
      ${iso(`${accountBase} + 2100000 + n`)}, ${actorUri("n")} || '#follow-other'
    FROM s WHERE (n * 17) % ${L} + 1 <> ${CELEB}`,
  );

  // Outbound follows: each local account follows `remoteFollowsPerAccount` actors,
  // and the first `hotActorFollowers` accounts follow the hot actor.
  await run(
    "outbound_follows",
    L * shape.remoteFollowsPerAccount,
    (from, to) => `${series(from, to)},
    pairs(i, j, n) AS (
      SELECT (n - 1) / ${shape.remoteFollowsPerAccount} + 1,
             (((n - 1) / ${shape.remoteFollowsPerAccount} + 1) * 53 + ((n - 1) % ${shape.remoteFollowsPerAccount} + 1) * 211) % ${R} + 1, n
      FROM s)
    INSERT OR IGNORE INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state, created_at)
    SELECT ${entityId(`${accountBase} + 3000000 + n`, "5")}, ${accountSql("i")}, ${actorUri("j")},
      'https://example.com/bench/follows/' || n, 'Accepted', ${iso(`${accountBase} + 3000000 + n`)}
    FROM pairs`,
  );
  await env.DB.prepare(`${series(1, shape.hotActorFollowers)}
    INSERT OR IGNORE INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state, created_at)
    SELECT ${entityId(`${accountBase} + 4000000 + n`, "6")}, ${accountSql("n")}, '${HOT_ACTOR_URI}',
      'https://example.com/bench/hot-follows/' || n, 'Accepted', ${iso(`${accountBase} + 4000000 + n`)}
    FROM s`).run();

  // Local statuses: 80% public, 10% unlisted, 7% private, 3% direct; every
  // 20th a boost, replies as `parentOf`.
  await run(
    "statuses",
    NL,
    (from, to) => `${series(from, to)}
    INSERT INTO statuses (id, account_id, kind, reblog_of_id, in_reply_to_id, in_reply_to_account_id,
      content_text, content_html, visibility, created_at, updated_at, language)
    SELECT ${localSql("n")}, ${accountSql(authorOf("n"))},
      CASE WHEN ${isReblog("n")} THEN 'LocalReblog' ELSE 'LocalNote' END,
      CASE WHEN ${isReblog("n")} THEN ${localSql("n - 5")} END,
      CASE WHEN NOT ${isReblog("n")} AND ${parentOf("n")} IS NOT NULL THEN ${localSql(parentOf("n"))} END,
      CASE WHEN NOT ${isReblog("n")} AND ${parentOf("n")} IS NOT NULL THEN ${accountSql(authorOf(parentOf("n")))} END,
      CASE WHEN ${isReblog("n")} THEN '' ELSE 'bench status ' || n || CASE WHEN n % 10 = 0 THEN ' #tag' || (n % 1000) ELSE '' END END,
      CASE WHEN ${isReblog("n")} THEN '' ELSE '<p>bench status ' || n || '</p>' END,
      CASE WHEN ${isReblog("n")} THEN 'public'
           WHEN n > ${threadRoot} AND n <= ${threadLeaf + 240} THEN 'public'
           WHEN n % 100 < 80 THEN 'public' WHEN n % 100 < 90 THEN 'unlisted'
           WHEN n % 100 < 97 THEN 'private' ELSE 'direct' END,
      ${iso(localMs("n"))}, ${iso(localMs("n"))}, CASE WHEN ${isReblog("n")} THEN NULL ELSE 'en' END
    FROM s`,
  );
  // Replies and direct notes mention whom they answer; every third direct note mentions the viewer.
  await run(
    "status_mentions",
    NL,
    (from, to) => `${series(from, to)}
    INSERT OR IGNORE INTO status_mentions (status_id, account_id)
    SELECT ${localSql("n")}, CASE WHEN ${parentOf("n")} IS NOT NULL THEN ${accountSql(authorOf(parentOf("n")))} ELSE ${accountSql(`${VIEWER}`)} END
    FROM s WHERE NOT ${isReblog("n")} AND (${parentOf("n")} IS NOT NULL OR (n % 100 >= 97 AND n % 3 = 0))`,
  );
  await run(
    "local_status_tags",
    NL,
    (from, to) => `${series(from, to)}
    INSERT OR IGNORE INTO local_status_tags (status_id, tag)
    SELECT ${localSql("n")}, CASE WHEN n % 20 = 3 THEN '${HOT_TAG}' ELSE 'tag' || (n % 1000) END
    FROM s WHERE NOT ${isReblog("n")} AND (n % 10 = 0 OR n % 20 = 3)`,
  );
  await env.DB.prepare(`${series(0, 999)}
    INSERT OR IGNORE INTO tags (name, created_at) SELECT 'tag' || n, ${iso(`${start}`)} FROM s`).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO tags (name, created_at) VALUES ('${HOT_TAG}', ${iso(`${start}`)})`,
  ).run();
  await run(
    "media_attachments",
    NL,
    (from, to) => `${series(from, to)}
    INSERT INTO media_attachments (id, account_id, status_id, object_key, content_type, created_at, position, width, height, file_size, description)
    SELECT ${localSql("n")}, ${accountSql(authorOf("n"))}, ${localSql("n")}, 'bench/media/' || n || '.png', 'image/png',
      ${iso(localMs("n"))}, 0, 640, 480, 12345, 'bench image ' || n
    FROM s WHERE n % 10 = 1`,
  );
  await run(
    "polls",
    NL,
    (from, to) => `${series(from, to)}
    INSERT INTO polls (id, status_id, multiple, expires_at, options_json)
    SELECT ${localSql("n")}, ${localSql("n")}, 0, ${iso(`${localMs("n")} + ${DAY}`)},
      '[{"title":"yes","votesCount":' || (n % 7) || '},{"title":"no","votesCount":' || (n % 5) || '}]'
    FROM s WHERE n % 100 = 11`,
  );
  await run(
    "poll_ids",
    NL,
    (from, to) => `${series(from, to)}
    UPDATE statuses SET poll_id = id WHERE id IN (SELECT ${localSql("n")} FROM s WHERE n % 100 = 11)`,
  );
  await run(
    "status_quotes",
    NL,
    (from, to) => `${series(from, to)}
    INSERT INTO status_quotes (id, status_id, quoted_status_id, state, created_at, updated_at)
    SELECT ${localSql("n")}, ${localSql("n")}, ${localSql("n - 1000")}, 'accepted', ${iso(localMs("n"))}, ${iso(localMs("n"))}
    FROM s WHERE n % 100 = 21 AND n > 1000`,
  );

  await run(
    "remote_statuses",
    NR,
    (from, to) => `${series(from, to)}
    INSERT INTO remote_statuses (id, actor_uri, object_uri, url, content_html, visibility, published_at, created_at, updated_at,
      media_json, tags_indexed, language, in_reply_to_uri)
    SELECT ${remoteSql("n")}, ${remoteAuthorOf("n")}, ${remoteAuthorOf("n")} || '/statuses/' || n, ${remoteAuthorOf("n")} || '/statuses/' || n,
      '<p>remote status ' || n || '</p>',
      CASE WHEN n % 100 < 85 THEN 'public' WHEN n % 100 < 95 THEN 'unlisted' ELSE 'private' END,
      ${iso(remoteMs("n"))}, ${iso(remoteMs("n"))}, ${iso(remoteMs("n"))},
      CASE WHEN n % 10 = 4 THEN '[{"url":"https://media.bench.example/' || n || '.png","mediaType":"image/png","description":"remote image","size":{"width":640,"height":480}}]' ELSE '[]' END,
      1, 'en',
      CASE WHEN n % 10 = 6 AND n > 10 THEN ${remoteAuthorOf("n - 5")} || '/statuses/' || (n - 5) END
    FROM s`,
  );
  await run(
    "remote_status_tags",
    NR,
    (from, to) => `${series(from, to)}
    INSERT OR IGNORE INTO remote_status_tags (status_id, tag)
    SELECT ${remoteSql("n")}, CASE WHEN n % 20 = 9 THEN '${HOT_TAG}' ELSE 'tag' || (n % 1000) END
    FROM s WHERE n % 10 = 5 OR n % 20 = 9`,
  );

  await run(
    "favourites",
    shape.favourites,
    (from, to) => `${series(from, to)}
    INSERT OR IGNORE INTO favourites (id, account_id, local_status_id, created_at)
    SELECT ${entityId(`${end} - 1000000 + n`, "8")}, ${accountSql(`(n * 13) % ${L} + 1`)}, ${localSql(`((n * 7919) % ${NL}) + 1`)},
      ${iso(`${end} - 1000000 + n`)}
    FROM s WHERE ((n * 7919) % ${NL} + 1) % 20 <> 7`,
  );

  // The viewer's notifications cycle favourite, reblog, mention, follow and status.
  const kinds = `CASE n % 5 WHEN 0 THEN 'favourite' WHEN 1 THEN 'reblog' WHEN 2 THEN 'mention' WHEN 3 THEN 'follow' ELSE 'status' END`;
  const notifiedStatus = (n: string) => localSql(`(${n} * 7) % ${NL} + 1`);
  await run(
    "viewer_notifications",
    shape.viewerNotifications,
    (from, to) => `${series(from, to)}
    INSERT INTO notifications (id, account_id, from_account_id, kind, status_id, created_at, group_key)
    SELECT ${entityId(`${start} + n * ${Math.floor(SPAN / shape.viewerNotifications)}`, "9")}, ${accountSql(`${VIEWER}`)},
      ${accountSql(`(n * 11) % ${L} + 1`)}, ${kinds},
      CASE WHEN n % 5 = 3 THEN NULL ELSE ${notifiedStatus("(n / 20)")} END,
      ${iso(`${start} + n * ${Math.floor(SPAN / shape.viewerNotifications)}`)},
      CASE n % 5
        WHEN 0 THEN 'favourite-' || ${notifiedStatus("(n / 20)")} || '-' || ((${start} + n * ${Math.floor(SPAN / shape.viewerNotifications)}) / ${HOUR})
        WHEN 1 THEN 'reblog-' || ${notifiedStatus("(n / 20)")} || '-' || ((${start} + n * ${Math.floor(SPAN / shape.viewerNotifications)}) / ${HOUR})
        WHEN 3 THEN 'follow-' || ((${start} + n * ${Math.floor(SPAN / shape.viewerNotifications)}) / ${HOUR})
        END
    FROM s`,
  );
  await run(
    "notifications",
    shape.otherNotifications,
    (from, to) => `${series(from, to)}
    INSERT INTO notifications (id, account_id, from_account_id, kind, status_id, created_at)
    SELECT ${entityId(`${start} + n * ${Math.floor(SPAN / shape.otherNotifications)}`, "10")}, ${accountSql(`(n * 3) % ${L} + 1`)},
      ${accountSql(`(n * 11) % ${L} + 1`)}, CASE n % 2 WHEN 0 THEN 'favourite' ELSE 'mention' END, ${notifiedStatus("n")},
      ${iso(`${start} + n * ${Math.floor(SPAN / shape.otherNotifications)}`)}
    FROM s WHERE (n * 3) % ${L} + 1 <> ${VIEWER}`,
  );

  // Two lists per owner of `listMembers` followed accounts, and the viewer's first list.
  await env.DB.prepare(`${series(1, shape.listOwners * 2)}
    INSERT INTO account_lists (id, account_id, title, created_at, updated_at)
    SELECT ${entityId(`${accountBase} + 5000000 + n`, "11")}, ${accountSql("(n + 1) / 2")}, 'list ' || n,
      ${iso(`${accountBase} + 5000000 + n`)}, ${iso(`${accountBase} + 5000000 + n`)}
    FROM s`).run();
  await env.DB.prepare(`${series(1, shape.listOwners * 2 * shape.listMembers)},
    m(l, k) AS (SELECT (n - 1) / ${shape.listMembers} + 1, (n - 1) % ${shape.listMembers} + 1 FROM s)
    INSERT OR IGNORE INTO account_list_members (list_id, member_account_id, created_at)
    SELECT ${entityId(`${accountBase} + 5000000 + l`, "11")},
      ${accountSql(`((((l + 1) / 2) * 37 + k * 101) % ${L} + 1)`)}, ${iso(`${accountBase} + 5000000 + l`)}
    FROM m WHERE (((l + 1) / 2) * 37 + k * 101) % ${L} + 1 <> (l + 1) / 2`).run();
  await env.DB.prepare(`${series(1, shape.listOwners * 2)}
    INSERT OR IGNORE INTO account_list_remote_members (list_id, outbound_follow_id, created_at)
    SELECT ${entityId(`${accountBase} + 5000000 + n`, "11")}, f.id, ${iso(`${accountBase} + 5000000`)}
    FROM s JOIN outbound_follows f ON f.account_id = ${accountSql("(n + 1) / 2")}
    WHERE n % 2 = 1`).run();
  await env.DB.prepare(`${series(1, shape.tagFollowers * 3)}
    INSERT OR IGNORE INTO followed_tags (account_id, tag_name, created_at)
    SELECT ${accountSql("(n - 1) / 3 + 1")}, CASE WHEN n % 3 = 1 THEN '${HOT_TAG}' ELSE 'tag' || ((n * 37) % 1000) END, ${iso(`${start}`)}
    FROM s`).run();
  await env.DB.prepare(`${series(1, 500)}
    INSERT OR IGNORE INTO bookmarks (id, account_id, local_status_id, created_at)
    SELECT ${entityId(`${end} - 2000000 + n`, "12")}, ${accountSql(`${VIEWER}`)}, ${localSql(`(n * 389) % ${NL} + 1`)}, ${iso(`${end} - 2000000 + n`)}
    FROM s WHERE ((n * 389) % ${NL} + 1) % 20 <> 7`).run();
  // Every fifth account has its home stream open, so fan-out renders for it.
  await env.DB.prepare(`${series(1, L)}
    INSERT OR IGNORE INTO stream_subscriptions (hub, stream) SELECT ${accountSql("n")}, 'user' FROM s WHERE n % 5 = 0`).run();
  // A fresh D1 has no `sqlite_stat1`: the planner works from the schema alone,
  // as the plan tests see it. `analyze` measures a database an operator ran
  // `PRAGMA optimize` on.
  if (analyze) await env.DB.prepare("ANALYZE").run();

  const id = (ms: number, low: number) =>
    (BigInt(ms) * 65536n + BigInt(low)).toString().padStart(18, "0");
  const accountId = (i: number) => id(accountBase + i, 0);
  const statusId = (n: number) => id(start + n * localStep, n % 32768);
  return {
    shape,
    accountId,
    statusId,
    threadRoot,
    threadLeaf,
    listId: id(accountBase + 5_000_000 + 1, 11),
    seconds: (Date.now() - started) / 1000,
  };
};
