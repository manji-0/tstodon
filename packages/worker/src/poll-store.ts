import { runD1, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import type { Result } from "neverthrow";

export type PollOption = Readonly<{ title: string; votesCount: number }>;

export type PollRecord = Readonly<{
  id: string;
  statusId: string;
  multiple: boolean;
  expiresAt: string;
  options: ReadonlyArray<PollOption>;
  votedIndexes: ReadonlyArray<number>;
}>;

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
    await db
      .prepare(`UPDATE statuses SET poll_id = ? WHERE id = ?`)
      .bind(id, input.statusId)
      .run();
    return id;
  });

type PollRow = {
  id: string;
  status_id: string;
  multiple: number;
  expires_at: string;
  options_json: string;
};

const pollFromRow = async (
  db: D1Database,
  row: PollRow,
  viewerId: string | undefined,
): Promise<PollRecord> => {
  const votes = viewerId
    ? await db
        .prepare(
          `SELECT option_index FROM poll_votes WHERE poll_id = ? AND account_id = ?`,
        )
        .bind(row.id, viewerId)
        .all<{ option_index: number }>()
    : { results: [] };
  return {
    id: row.id,
    statusId: row.status_id,
    multiple: row.multiple === 1,
    expiresAt: row.expires_at,
    options: JSON.parse(row.options_json) as PollOption[],
    votedIndexes: (votes.results ?? []).map((vote) => vote.option_index),
  };
};

export const findPollByStatusId = async (
  db: D1Database,
  statusId: string,
  viewerId: string | undefined,
): Promise<Result<PollRecord | undefined, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(
        `SELECT id, status_id, multiple, expires_at, options_json FROM polls WHERE status_id = ?`,
      )
      .bind(statusId)
      .first<PollRow>();
    if (!row) {
      return undefined;
    }
    return pollFromRow(db, row, viewerId);
  });

export const findPollById = async (
  db: D1Database,
  pollId: string,
  viewerId: string | undefined,
): Promise<Result<PollRecord | undefined, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(
        `SELECT id, status_id, multiple, expires_at, options_json FROM polls WHERE id = ?`,
      )
      .bind(pollId)
      .first<PollRow>();
    if (!row) {
      return undefined;
    }
    return pollFromRow(db, row, viewerId);
  });

export const votePoll = async (
  db: D1Database,
  pollId: string,
  accountId: string,
  choices: ReadonlyArray<number>,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(`SELECT options_json FROM polls WHERE id = ?`)
      .bind(pollId)
      .first<{ options_json: string }>();
    if (!row) {
      throw new Error("poll not found");
    }
    const options = JSON.parse(row.options_json) as PollOption[];
    for (const choice of choices) {
      const option = options[choice];
      if (!option) {
        continue;
      }
      options[choice] = { title: option.title, votesCount: option.votesCount + 1 };
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
      .bind(JSON.stringify(options), pollId)
      .run();
  });
