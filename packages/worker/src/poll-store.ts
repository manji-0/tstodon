import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import {
  ExpiredPollTargetRowSchema,
  parseJsonColumn,
  parseRow,
  PollOptionsSchema,
  PollRowSchema,
  toRepositoryError,
} from "./schemas";

export type PollOption = Readonly<{ title: string; votesCount: number }>;

export type PollRecord = Readonly<{
  id: string;
  statusId: string;
  multiple: boolean;
  expiresAt: string;
  options: ReadonlyArray<PollOption>;
  votedIndexes: ReadonlyArray<number>;
}>;

export type PollRow = z.infer<typeof PollRowSchema>;

export const insertPoll = async (
  db: D1Database,
  input: {
    statusId: string;
    multiple: boolean;
    expiresAt: string;
    options: ReadonlyArray<string>;
  },
): Promise<Result<string, RepositoryError>> =>
  runD1(async () => {
    const id = newEntityId();
    await db
      .prepare(
        `INSERT INTO polls (id, status_id, multiple, expires_at, options_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.statusId,
        input.multiple ? 1 : 0,
        input.expiresAt,
        JSON.stringify(input.options.map((title) => ({ title, votesCount: 0 }))),
      )
      .run();
    await db.prepare(`UPDATE statuses SET poll_id = ? WHERE id = ?`).bind(id, input.statusId).run();
    return id;
  });

const pollFromRow = async (
  db: D1Database,
  row: PollRow,
  viewerId: string | undefined,
): Promise<Result<PollRecord, RepositoryError>> => {
  const options = parseJsonColumn(PollOptionsSchema, row.options_json);
  if (options.isErr()) {
    return err(options.error);
  }
  const votes = viewerId
    ? await runD1(() =>
        db
          .prepare(`SELECT option_index FROM poll_votes WHERE poll_id = ? AND account_id = ?`)
          .bind(row.id, viewerId)
          .all<{ option_index: number }>(),
      )
    : ok<{ results: { option_index: number }[] }>({ results: [] });
  if (votes.isErr()) {
    return err(votes.error);
  }
  return ok({
    id: row.id,
    statusId: row.status_id,
    multiple: row.multiple === 1,
    expiresAt: row.expires_at,
    options: options.value,
    votedIndexes: (votes.value.results ?? []).map((vote) => vote.option_index),
  });
};

const loadPoll = async (
  queried: Result<unknown, RepositoryError>,
  db: D1Database,
  viewerId: string | undefined,
): Promise<Result<PollRecord | undefined, RepositoryError>> => {
  if (queried.isErr()) {
    return err(queried.error);
  }
  if (!queried.value) {
    return ok(undefined);
  }
  const row = parseRow(PollRowSchema, queried.value);
  if (row.isErr()) {
    return err(toRepositoryError("invalid poll row"));
  }
  const poll = await pollFromRow(db, row.value, viewerId);
  if (poll.isErr()) {
    return err(poll.error);
  }
  return ok(poll.value);
};

export const findPollByStatusId = async (
  db: D1Database,
  statusId: string,
  viewerId: string | undefined,
): Promise<Result<PollRecord | undefined, RepositoryError>> => {
  const queried = await runD1(() =>
    db
      .prepare(
        `SELECT id, status_id, multiple, expires_at, options_json FROM polls WHERE status_id = ?`,
      )
      .bind(statusId)
      .first(),
  );
  return loadPoll(queried, db, viewerId);
};

export const findPollById = async (
  db: D1Database,
  pollId: string,
  viewerId: string | undefined,
): Promise<Result<PollRecord | undefined, RepositoryError>> => {
  const queried = await runD1(() =>
    db
      .prepare(`SELECT id, status_id, multiple, expires_at, options_json FROM polls WHERE id = ?`)
      .bind(pollId)
      .first(),
  );
  return loadPoll(queried, db, viewerId);
};

export const votePoll = async (
  db: D1Database,
  pollId: string,
  accountId: string,
  choices: ReadonlyArray<number>,
): Promise<Result<void, RepositoryError>> => {
  const queried = await runD1(() =>
    db.prepare(`SELECT options_json, expires_at FROM polls WHERE id = ?`).bind(pollId).first(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  if (!queried.value) {
    return err(toRepositoryError("poll not found"));
  }
  const row = parseRow(
    z.object({
      options_json: z.string().min(1),
      expires_at: z.string().min(1),
    }),
    queried.value,
  );
  if (row.isErr()) {
    return err(toRepositoryError("invalid poll row"));
  }
  if (Date.parse(row.value.expires_at) <= Date.now()) {
    return err(toRepositoryError("poll expired"));
  }
  const options = parseJsonColumn(PollOptionsSchema, row.value.options_json);
  if (options.isErr()) {
    return err(options.error);
  }
  const next = options.value.map((option) => ({ ...option }));
  return runD1(async () => {
    for (const choice of choices) {
      const option = next[choice];
      if (!option) {
        continue;
      }
      next[choice] = { title: option.title, votesCount: option.votesCount + 1 };
      await db
        .prepare(
          `INSERT OR IGNORE INTO poll_votes (poll_id, account_id, option_index, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(pollId, accountId, choice, nowIso())
        .run();
    }
    await db
      .prepare(`UPDATE polls SET options_json = ? WHERE id = ?`)
      .bind(JSON.stringify(next), pollId)
      .run();
  });
};

export type ExpiredPollTarget = Readonly<{
  id: string;
  statusId: string;
  accountId: string;
}>;

export const listExpiredUnnotifiedPolls = async (
  db: D1Database,
  now: string,
  limit: number,
): Promise<Result<ExpiredPollTarget[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT p.id, p.status_id, s.account_id
         FROM polls p
         JOIN statuses s ON s.id = p.status_id
         WHERE p.expires_at <= ? AND p.expiry_notified_at IS NULL
         ORDER BY p.expires_at ASC
         LIMIT ?`,
      )
      .bind(now, limit)
      .all();
    return (results ?? []).flatMap((raw) => {
      const row = parseRow(ExpiredPollTargetRowSchema, raw);
      return row.isOk()
        ? [
            {
              id: row.value.id,
              statusId: row.value.status_id,
              accountId: row.value.account_id,
            },
          ]
        : [];
    });
  });

export const markPollExpiryNotified = async (
  db: D1Database,
  pollId: string,
  notifiedAt: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `UPDATE polls SET expiry_notified_at = ?
         WHERE id = ? AND expiry_notified_at IS NULL`,
      )
      .bind(notifiedAt, pollId)
      .run();
  });
