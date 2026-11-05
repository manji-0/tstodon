import { warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, type RepositoryError, runD1, runD1Batch, sqlInJsonEach } from "./d1";
import { newEntityId } from "./ids";
import { parseJsonColumn } from "./json-column";
import { parseRows, toRepositoryError } from "./d1";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import {
  claimLocalPollExpiryNotice as claimLocalPollExpiryNoticeSql,
  claimPollUpdate as claimPollUpdateSql,
  countPollVotes as countPollVotesSql,
  findPollById as findPollByIdSql,
  findPollByStatusId as findPollByStatusIdSql,
  findPollVoteTarget as findPollVoteTargetSql,
  insertPoll as insertPollSql,
  insertPollVoteOrIgnore as insertPollVoteOrIgnoreSql,
  insertRemotePollVoteOrIgnore as insertRemotePollVoteOrIgnoreSql,
  listEndedLocalPollVoters as listEndedLocalPollVotersSql,
  listExpiredUnnotifiedPolls as listExpiredUnnotifiedPollsSql,
  listPollVotesForAccount as listPollVotesForAccountSql,
  listRemotePollVotesForActor as listRemotePollVotesForActorSql,
  markPollExpiryNotified as markPollExpiryNotifiedSql,
  releasePollUpdate as releasePollUpdateSql,
  replacePollOptions as replacePollOptionsSql,
  updatePollOptionsIfActive as updatePollOptionsIfActiveSql,
  updateStatusPollId as updateStatusPollIdSql,
} from "./generated/prisma/sql";

const OptionIndexRow = z.object({ option_index: z.number() });
const CountRow = z.object({ count: z.union([z.number(), z.bigint()]) });
const IdRow = z.object({ id: z.string() });
const NullableIdRow = z.object({ id: z.string().nullable() });

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
  voters_count: z.number(),
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
  /** Distinct accounts that voted, local and remote. */
  votersCount: number;
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
        queryTyped(db, listPollVotesForAccountSql(row.id, viewerId), OptionIndexRow),
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
    votersCount: row.voters_count,
    votedIndexes: votes.value.map((vote) => vote.option_index),
  });
};

const loadPoll = async (
  queried: Result<z.infer<typeof PollRowSchema> | undefined, RepositoryError>,
  db: D1Database,
  viewerId: string | undefined,
): Promise<Result<PollRecord | undefined, RepositoryError>> => {
  if (queried.isErr()) {
    return err(queried.error);
  }
  if (queried.value === undefined) {
    return ok(undefined);
  }
  const poll = await pollFromRow(db, queried.value, viewerId);
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
    const rows = await queryTyped(db, findPollByStatusIdSql(statusId), PollRowSchema);
    return rows[0];
  });
  return loadPoll(queried, db, viewerId);
};

/** The poll a note federates with its `Question`, or undefined for a plain note. */
export const loadNotePoll = async (
  db: D1Database,
  statusId: string,
): Promise<PollRecord | undefined> =>
  (await findPollByStatusId(db, statusId, undefined)).unwrapOr(undefined);

/** Total votes cast on a poll, across all accounts and options. */
export const countPollVotes = async (
  db: D1Database,
  pollId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, countPollVotesSql(pollId), CountRow);
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
    const rows = await queryTyped(
      db,
      replacePollOptionsSql(
        input.pollId,
        JSON.stringify(input.options.map((title) => ({ title, votesCount: 0 }))),
        input.multiple ? 1 : 0,
        input.expiresAt,
        input.hideTotals ? 1 : 0,
      ),
      IdRow,
    );
    return rows.length > 0;
  });

export const findPollsByStatusIds = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
  viewerId: string | undefined,
): Promise<Result<Map<string, PollRecord>, RepositoryError>> => {
  const unique = [...new Set(statusIds.filter((id) => id.length > 0))];
  if (unique.length === 0) {
    return ok(new Map<string, PollRecord>());
  }
  const queried = await runD1(() =>
    db
      .prepare(
        `SELECT id, status_id, multiple, expires_at, options_json, hide_totals,
           (SELECT COUNT(*) FROM (
             SELECT account_id FROM poll_votes WHERE poll_id = polls.id
             UNION
             SELECT actor_uri FROM remote_poll_votes WHERE poll_id = polls.id
           )) AS voters_count
         FROM polls WHERE status_id ${sqlInJsonEach()}`,
      )
      .bind(jsonStringArray(unique))
      .all(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  const rows = parseRows(PollRowSchema, queried.value.results);
  if (rows.length === 0) {
    return ok(new Map<string, PollRecord>());
  }
  const viewerVotes = viewerId
    ? (
        await runD1(() =>
          db
            .prepare(
              `SELECT poll_id, option_index FROM poll_votes
             WHERE account_id = ? AND poll_id ${sqlInJsonEach()}`,
            )
            .bind(viewerId, jsonStringArray(rows.map((row) => row.id)))
            .all<{ poll_id: string; option_index: number }>(),
        )
      ).map(({ results }) => results ?? [])
    : ok([]);
  if (viewerVotes.isErr()) {
    return err(viewerVotes.error);
  }
  const votesByPoll = new Map(
    [...Map.groupBy(viewerVotes.value, (vote) => vote.poll_id)].map(([pollId, votes]) => [
      pollId,
      votes.map((vote) => vote.option_index),
    ]),
  );
  return ok(
    new Map(
      rows.flatMap((row): [string, PollRecord][] => {
        const options = parseJsonColumn(PollOptionsSchema, row.options_json);
        return options.isErr()
          ? []
          : [
              [
                row.status_id,
                {
                  id: row.id,
                  statusId: row.status_id,
                  multiple: row.multiple === 1,
                  expiresAt: row.expires_at,
                  hideTotals: row.hide_totals === 1,
                  options: options.value,
                  votersCount: row.voters_count,
                  votedIndexes: votesByPoll.get(row.id) ?? [],
                },
              ],
            ];
      }),
    ),
  );
};

export const findPollById = async (
  db: D1Database,
  pollId: string,
  viewerId: string | undefined,
): Promise<Result<PollRecord | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    const rows = await queryTyped(db, findPollByIdSql(pollId), PollRowSchema);
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
    return queryTyped(db, findPollVoteTargetSql(pollId), PollVoteTargetRowSchema);
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const target = queried.value[0];
  if (!target) {
    return err(toRepositoryError("poll not found"));
  }
  if (Date.parse(target.expires_at) <= Date.now()) {
    return err(toRepositoryError("poll expired"));
  }
  const options = parseJsonColumn(PollOptionsSchema, target.options_json);
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

/** What became of a vote a remote account cast on a local poll. */
export type RemotePollVoteOutcome = Readonly<{
  kind: "Recorded" | "Expired" | "UnknownOption" | "Duplicate" | "AlreadyVoted";
}>;

/**
 * Count a remote account's vote for the option titled `title`. As for a local
 * voter, a single-choice poll takes one option per account and a multiple-choice
 * poll one vote per option; Mastodon sends one `Create` per chosen option.
 */
export const recordRemotePollVote = async (
  db: D1Database,
  poll: PollRecord,
  vote: Readonly<{ actorUri: string; objectUri: string; title: string }>,
): Promise<Result<RemotePollVoteOutcome, RepositoryError>> => {
  if (Date.parse(poll.expiresAt) <= Date.now()) {
    return ok({ kind: "Expired" });
  }
  const choice = poll.options.findIndex((option) => option.title === vote.title);
  const chosen = poll.options[choice];
  if (!chosen) {
    return ok({ kind: "UnknownOption" });
  }
  const earlier = await runD1(async () =>
    queryTyped(db, listRemotePollVotesForActorSql(poll.id, vote.actorUri), OptionIndexRow),
  );
  if (earlier.isErr()) {
    return err(earlier.error);
  }
  if (earlier.value.some((row) => row.option_index === choice)) {
    return ok({ kind: "Duplicate" });
  }
  if (!poll.multiple && earlier.value.length > 0) {
    return ok({ kind: "AlreadyVoted" });
  }
  const next = poll.options.map((option, index) =>
    index === choice ? { title: chosen.title, votesCount: chosen.votesCount + 1 } : option,
  );
  const now = nowIso();
  const batched = await runD1Batch(db, [
    d1PrepareTyped(
      db,
      insertRemotePollVoteOrIgnoreSql(poll.id, vote.actorUri, choice, vote.objectUri, now),
    ),
    d1PrepareTyped(db, updatePollOptionsIfActiveSql(JSON.stringify(next), poll.id, now)),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const updated = batched.value[1];
  return ok({ kind: (updated?.meta.changes ?? 0) === 0 ? "Expired" : "Recorded" });
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
    const results = await queryTyped(
      db,
      listExpiredUnnotifiedPollsSql(now, limit),
      ExpiredPollTargetRowSchema,
    );
    return results.map((row) => ({
      id: row.id,
      statusId: row.status_id,
      accountId: row.account_id,
    }));
  });

/** Mark the poll's end as announced; true for the one caller that marked it. */
export const markPollExpiryNotified = async (
  db: D1Database,
  pollId: string,
  notifiedAt: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(
    async () =>
      ((await runTyped(db, markPollExpiryNotifiedSql(notifiedAt, pollId))).meta.changes ?? 0) > 0,
  );

/** A local account other than the author that voted on a local poll which has since ended. */
export type EndedLocalPollVoter = Readonly<{
  kind: "LocalPollVoter";
  pollId: string;
  statusId: string;
  accountId: string;
  authorId: string;
}>;

const EndedLocalPollVoterRow = z.object({
  poll_id: z.string(),
  status_id: z.string(),
  account_id: z.string(),
  author_id: z.string(),
});

/** Voters of local polls that ended by `now` and have not been told. */
export const listEndedLocalPollVoters = async (
  db: D1Database,
  now: string,
  limit: number,
): Promise<Result<EndedLocalPollVoter[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      listEndedLocalPollVotersSql(now, limit),
      EndedLocalPollVoterRow,
    );
    return rows.map((row) => ({
      kind: "LocalPollVoter" as const,
      pollId: row.poll_id,
      statusId: row.status_id,
      accountId: row.account_id,
      authorId: row.author_id,
    }));
  });

/** Mark the voter as told; true for the one caller that marked it, so each voter is told once. */
export const claimLocalPollExpiryNotice = async (
  db: D1Database,
  notifiedAt: string,
  voter: EndedLocalPollVoter,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const result = await runTyped(
      db,
      claimLocalPollExpiryNoticeSql(notifiedAt, voter.pollId, voter.accountId),
    );
    return (result.meta.changes ?? 0) > 0;
  });

/**
 * Take the poll's single `Update` slot. True when this caller took it and must
 * queue the job; false when a job is already queued for the poll.
 */
/**
 * A claim older than this is taken over: its job was lost (dropped after its
 * retries, or the release failed), and keeping it would stop every later Update.
 */
const POLL_UPDATE_CLAIM_TTL_MS = 10 * 60 * 1000;

export const claimPollUpdate = async (
  db: D1Database,
  pollId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const now = Date.now();
    const rows = await queryTyped(
      db,
      claimPollUpdateSql(
        new Date(now).toISOString(),
        pollId,
        new Date(now - POLL_UPDATE_CLAIM_TTL_MS).toISOString(),
      ),
      NullableIdRow,
    );
    return rows.length > 0;
  });

/** Free the poll's `Update` slot so the next vote queues a fresh job. */
export const releasePollUpdate = async (db: D1Database, pollId: string): Promise<void> => {
  await runTyped(db, releasePollUpdateSql(pollId));
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([PollOptionSchema, PollOptionsSchema, PollRowSchema, ExpiredPollTargetRowSchema]);
