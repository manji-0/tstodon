import type { OutboxJob } from "@tstodon/domain";
import { type Result } from "neverthrow";
import { z } from "zod";
import { findAccountsByIds } from "./account-store";
import { jsonStringArray, parseRows, type RepositoryError, runD1 } from "./d1";
import { measureJobPage } from "./metrics";
import { sendFollowUndo } from "./outbound-follow";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { sendFollowReject } from "./remote-follower";
import { parseInstanceIdentity } from "./runtime-config";

/**
 * The `Reject(Follow)` and `Undo(Follow)` a domain suspension owes the
 * suspended server (`severance_notices`, migration 0175), sent in bounded
 * queued pages. `severRelationships` writes them with the follows it removes.
 */

type SendJob = Extract<OutboxJob, { kind: "SendSeveranceNotices" }>;

/** Notices one page sends: each costs a few D1 queries to queue its activity. */
export const SEVERANCE_NOTICE_PAGE_SIZE = 20;

/** A claim older than this belongs to a page that stopped; another takes it. */
const CLAIM_EXPIRES_MS = 10 * 60 * 1000;

const NoticeRowSchema = z.object({
  id: z.string(),
  kind: z.union([z.literal("Reject"), z.literal("Undo")]),
  account_id: z.string(),
  actor_uri: z.string(),
  follow_activity_id: z.string().nullable(),
});

type NoticeRow = z.infer<typeof NoticeRowSchema>;

/** Claim the next page of notices no live page holds. */
const claimNotices = (
  db: D1Database,
  nowMs: number,
  limit: number,
): Promise<Result<NoticeRow[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `UPDATE severance_notices SET claimed_at = ?1
         WHERE id IN (
           SELECT id FROM severance_notices
           WHERE claimed_at IS NULL OR claimed_at < ?2
           ORDER BY id LIMIT ?3
         )
         RETURNING id, kind, account_id, actor_uri, follow_activity_id`,
      )
      .bind(new Date(nowMs).toISOString(), new Date(nowMs - CLAIM_EXPIRES_MS).toISOString(), limit)
      .all();
    return parseRows(NoticeRowSchema, results);
  });

/** Delete the notices sent, and give back the claims of those that were not. */
const settleNotices = (
  db: D1Database,
  sent: ReadonlyArray<string>,
  unsent: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db.batch([
      db
        .prepare("DELETE FROM severance_notices WHERE id IN (SELECT value FROM json_each(?))")
        .bind(jsonStringArray(sent)),
      db
        .prepare(
          "UPDATE severance_notices SET claimed_at = NULL WHERE id IN (SELECT value FROM json_each(?))",
        )
        .bind(jsonStringArray(unsent)),
    ]);
  });

/** Whether any notice waits to be sent (hourly cron). */
export const hasSeveranceNotices = async (env: Env): Promise<boolean> => {
  const found = await runD1(async () =>
    parseRows(
      z.object({ one: z.number() }),
      (await env.DB.prepare("SELECT 1 AS one FROM severance_notices LIMIT 1").all()).results,
    ),
  );
  return found.isOk() && found.value.length > 0;
};

/**
 * Send the next page of notices and delete them; a notice whose account or
 * actor is gone has no one to send it and is deleted too. A notice that could
 * not be queued is given back and the page retried. A full page queues the
 * next one. A page that stops after sending holds its claim until it expires,
 * and the notices go again: a repeated `Reject` or `Undo` changes nothing.
 */
export const processSendSeveranceNoticesJob = (env: Env, job: SendJob) =>
  measureJobPage(env, job.kind, async () => {
    const identity = parseInstanceIdentity(env);
    const claimed = await claimNotices(env.DB, Date.now(), SEVERANCE_NOTICE_PAGE_SIZE);
    if (identity.isErr() || claimed.isErr()) {
      return { outcome: "retry", size: -1, chained: false };
    }
    const notices = claimed.value;
    const [accounts, actors] = await Promise.all([
      findAccountsByIds(
        env.DB,
        notices.map((notice) => notice.account_id),
      ),
      findRemoteActorsByUris(
        env.DB,
        notices.map((notice) => notice.actor_uri),
      ),
    ]);
    if (accounts.isErr() || actors.isErr()) {
      await settleNotices(
        env.DB,
        [],
        notices.map((notice) => notice.id),
      );
      return { outcome: "retry", size: -1, chained: false };
    }
    const sent: string[] = [];
    const unsent: string[] = [];
    for (const notice of notices) {
      const account = accounts.value.get(notice.account_id);
      const actor = actors.value.get(notice.actor_uri);
      const followId = notice.follow_activity_id;
      if (!account || !actor) {
        sent.push(notice.id);
        continue;
      }
      if (notice.kind === "Reject") {
        const queued = await sendFollowReject(
          env,
          identity.value,
          account,
          actor,
          followId ?? actor.actorUri,
          "AlsoSuspended",
        );
        (queued.isOk() ? sent : unsent).push(notice.id);
      } else if (followId !== null) {
        const queued = await sendFollowUndo(
          env,
          identity.value,
          account,
          actor,
          followId,
          "AlsoSuspended",
        );
        (queued.isOk() ? sent : unsent).push(notice.id);
      } else {
        sent.push(notice.id);
      }
    }
    const settled = await settleNotices(env.DB, sent, unsent);
    if (settled.isErr() || unsent.length > 0) {
      return { outcome: "retry", size: sent.length, chained: false };
    }
    const chained = notices.length === SEVERANCE_NOTICE_PAGE_SIZE;
    if (chained) {
      await env.OUTBOX_PROCESS_QUEUE.send(job);
    }
    return { outcome: "ok", size: notices.length, chained };
  });
