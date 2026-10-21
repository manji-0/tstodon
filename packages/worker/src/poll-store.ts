import { warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, type RepositoryError, runD1, runD1Batch, sqlInJsonEach } from "./d1";
import { newEntityId } from "./ids";
import { parseJsonColumn } from "./json-column";
import { parseRow, toRepositoryError } from "./d1";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import {
  countPollVotes as countPollVotesSql,
  findPollById as findPollByIdSql,
  findPollByStatusId as findPollByStatusIdSql,
  findPollVoteTarget as findPollVoteTargetSql,
  insertPoll as insertPollSql,
  insertPollVoteOrIgnore as insertPollVoteOrIgnoreSql,
  listExpiredUnnotifiedPolls as listExpiredUnnotifiedPollsSql,
  listPollVotesForAccount as listPollVotesForAccountSql,
  markPollExpiryNotified as markPollExpiryNotifiedSql,
  replacePollOptions as replacePollOptionsSql,
  updatePollOptionsIfActive as updatePollOptionsIfActiveSql,
  updateStatusPollId as updateStatusPollIdSql,
} from "./generated/prisma/sql";

export const PollOptionSchema = z.object({
  title: z.string(),
  votesCount: z.number().int().nonnegative(),
});

export const PollOptionsSchema = z.array(PollOptionSchema);

export const PollRowSchema = z.object({
  id: z.string().min(1),
  status_id: z.string().min(1),
  multiple: z.number(),
  expires_at: z.string().min(1),
  options_json: z.string().min(1),
  hide_totals: z.number(),
});

export const ExpiredPollTargetRowSchema = z.object({
  id: z.string().min(1),
  status_id: z.string().min(1),
  account_id: z.string().min(1),
});

export const PollVoteTargetRowSchema = z.object({
  options_json: z.string().min(1),
  expires_at: z.string().min(1),
});

warmSchemas([PollVoteTargetRowSchema]);

export type PollOption = Readonly<{ title: string; votesCount: number }>;

export type PollRecord = Readonly<{
  id: string;
  statusId: string;
  multiple: boolean;
  expiresAt: string;
  hideTotals: boolean;
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
    hideTotals?: boolean;
  },
): Promise<Result<string, RepositoryError>> => {
  const id = newEntityId();
  const batched = await runD1Batch(db, [
    d1PrepareTyped(
      db,
      insertPollSql(
        id,
        input.statusId,
        input.multiple ? 1 : 0,
        input.expiresAt,
        JSON.stringify(input.options.map((title) => ({ title, votesCount: 0 }))),
        input.hideTotals ? 1 : 0,
      ),
    ),
    d1PrepareTyped(db, updateStatusPollIdSql(id, input.statusId)),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(id);
};

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
    ? await runD1(async () =>
        queryTyped<{ option_index: number }>(db, listPollVotesForAccountSql(row.id, viewerId)),
      )
    : ok<{ option_index: number }[]>([]);
  if (votes.isErr()) {
    return err(votes.error);
  }
  return ok({
    id: row.id,
    statusId: row.status_id,
    multiple: row.multiple === 1,
    expiresAt: row.expires_at,
    hideTotals: row.hide_totals === 1,
    options: options.value,
    votedIndexes: votes.value.map((vote) => vote.option_index),
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
  const queried = await runD1(async () => {
    const rows = await queryTyped(db, findPollByStatusIdSql(statusId));
    return rows[0];
  });
  return loadPoll(queried, db, viewerId);
};

/** Total votes cast on a poll, across all accounts and options. */
export const countPollVotes = async (
  db: D1Database,
  pollId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ count: number | bigint }>(db, countPollVotesSql(pollId));
    return Number(rows[0]?.count ?? 0);
  });

/** Replace a poll's options. Callers must first confirm no votes and no expiry. */
export const replacePollOptions = async (
  db: D1Database,
  input: {
    pollId: string;
    options: ReadonlyArray<string>;
    multiple: boolean;
    expiresAt: string;
    hideTotals: boolean;
  },
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(
      db,
      replacePollOptionsSql(
        input.pollId,
        JSON.stringify(input.options.map((title) => ({ title, votesCount: 0 }))),
        input.multiple ? 1 : 0,
        input.expiresAt,
        input.hideTotals ? 1 : 0,
      ),
    );
    return rows.length > 0;
  });

export const findPollsByStatusIds = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
  viewerId: string | undefined,
): Promise<Result<Map<string, PollRecord>, RepositoryError>> => {
  const unique = [...new Set(statusIds.filter((id) => id.length > 0))];
  const polls = new Map<string, PollRecord>();
  if (unique.length === 0) {
    return ok(polls);
  }
  const rows: PollRow[] = [];
  const queried = await runD1(() =>
    db
      .prepare(
        `SELECT id, status_id, multiple, expires_at, options_json, hide_totals
         FROM polls WHERE status_id ${sqlInJsonEach()}`,
      )
      .bind(jsonStringArray(unique))
      .all(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  for (const raw of queried.value.results ?? []) {
    const row = parseRow(PollRowSchema, raw);
    if (row.isOk()) {
      rows.push(row.value);
    }
  }
  if (rows.length === 0) {
    return ok(polls);
  }
  const votesByPoll = new Map<string, number[]>();
  if (viewerId) {
    const pollIds = rows.map((row) => row.id);
    const votesQueried = await runD1(() =>
      db
        .prepare(
          `SELECT poll_id, option_index FROM poll_votes
           WHERE account_id = ? AND poll_id ${sqlInJsonEach()}`,
        )
        .bind(viewerId, jsonStringArray(pollIds))
        .all<{ poll_id: string; option_index: number }>(),
    );
    if (votesQueried.isErr()) {
      return err(votesQueried.error);
    }
    for (const vote of votesQueried.value.results ?? []) {
      const list = votesByPoll.get(vote.poll_id) ?? [];
      list.push(vote.option_index);
      votesByPoll.set(vote.poll_id, list);
    }
  }
  for (const row of rows) {
    const options = parseJsonColumn(PollOptionsSchema, row.options_json);
    if (options.isErr()) {
      continue;
    }
    polls.set(row.status_id, {
      id: row.id,
      statusId: row.status_id,
      multiple: row.multiple === 1,
      expiresAt: row.expires_at,
      hideTotals: row.hide_totals === 1,
      options: options.value,
      votedIndexes: votesByPoll.get(row.id) ?? [],
    });
  }
  return ok(polls);
};

export const findPollById = async (
  db: D1Database,
  pollId: string,
  viewerId: string | undefined,
): Promise<Result<PollRecord | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    const rows = await queryTyped(db, findPollByIdSql(pollId));
    return rows[0];
  });
  return loadPoll(queried, db, viewerId);
};

export const votePoll = async (
  db: D1Database,
  pollId: string,
  accountId: string,
  choices: ReadonlyArray<number>,
): Promise<Result<void, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped(db, findPollVoteTargetSql(pollId));
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const target = queried.value[0];
  if (!target) {
    return err(toRepositoryError("poll not found"));
  }
  const row = parseRow(PollVoteTargetRowSchema, target);
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
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  for (const choice of choices) {
    const option = next[choice];
    if (!option) {
      continue;
    }
    next[choice] = { title: option.title, votesCount: option.votesCount + 1 };
    statements.push(d1PrepareTyped(db, insertPollVoteOrIgnoreSql(pollId, accountId, choice, now)));
  }
  statements.push(
    d1PrepareTyped(db, updatePollOptionsIfActiveSql(JSON.stringify(next), pollId, now)),
  );
  const batched = await runD1Batch(db, statements);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const updateResult = batched.value[batched.value.length - 1];
  if ((updateResult?.meta.changes ?? 0) === 0) {
    return err(toRepositoryError("poll expired"));
  }
  return ok(undefined);
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
    const results = await queryTyped(db, listExpiredUnnotifiedPollsSql(now, limit));
    return results.flatMap((raw) => {
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
    await runTyped(db, markPollExpiryNotifiedSql(notifiedAt, pollId));
  });

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([PollOptionSchema, PollOptionsSchema, PollRowSchema, ExpiredPollTargetRowSchema]);
