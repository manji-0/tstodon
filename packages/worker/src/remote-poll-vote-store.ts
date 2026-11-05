import { z } from "zod";
import type { RemoteStatus } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { jsonStringArray, type RepositoryError, runD1, runD1Batch } from "./d1";
import {
  claimRemotePollExpiryNotice as claimRemotePollExpiryNoticeSql,
  insertRemotePollOwnVote as insertRemotePollOwnVoteSql,
  listEndedRemotePollVoters as listEndedRemotePollVotersSql,
  listRemotePollVotes as listRemotePollVotesSql,
  settleRemotePollOwnVotes as settleRemotePollOwnVotesSql,
} from "./generated/prisma/sql";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";

/**
 * What local accounts have voted on one remote poll: the viewer's own
 * choices, and the votes still added on top of the author's cached counts
 * because the author has not reported them back yet.
 */
export type RemotePollVotes = Readonly<{
  ownChoices: ReadonlyArray<number>;
  pendingByChoice: ReadonlyMap<number, number>;
  pendingVoters: number;
}>;

export const NO_REMOTE_POLL_VOTES: RemotePollVotes = {
  ownChoices: [],
  pendingByChoice: new Map(),
  pendingVoters: 0,
};

const VoteRowSchema = z.object({
  status_id: z.string(),
  account_id: z.string(),
  choice_index: z.number(),
  optimistic: z.number(),
});

type VoteRow = z.infer<typeof VoteRowSchema>;

const votesByStatus = (
  rows: ReadonlyArray<VoteRow>,
  viewerId: string,
): ReadonlyMap<string, RemotePollVotes> => {
  return new Map(
    [...Map.groupBy(rows, (row) => row.status_id)].map(
      ([statusId, votes]): [string, RemotePollVotes] => {
        const pending = votes.filter((vote) => vote.optimistic === 1);
        const pendingByChoice = new Map(
          [...Map.groupBy(pending, (vote) => vote.choice_index)].map(([choice, voters]) => [
            choice,
            voters.length,
          ]),
        );
        return [
          statusId,
          {
            ownChoices: votes
              .filter((vote) => vote.account_id === viewerId)
              .map((vote) => vote.choice_index),
            pendingByChoice,
            pendingVoters: new Set(pending.map((vote) => vote.account_id)).size,
          },
        ];
      },
    ),
  );
};

/**
 * The votes behind a page of remote statuses, in one query. Statuses without
 * a poll are not asked about, and statuses nobody voted on are absent from
 * the result. A failed lookup reads as no votes: the status still renders.
 */
export const findRemotePollVotes = async (
  db: D1Database,
  viewerId: string | undefined,
  statuses: ReadonlyArray<Pick<RemoteStatus, "id" | "poll">>,
): Promise<ReadonlyMap<string, RemotePollVotes>> => {
  const ids = statuses.flatMap((status) => (status.poll.kind === "NoPoll" ? [] : [status.id]));
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await runD1(async () =>
    queryTyped(db, listRemotePollVotesSql(viewerId ?? "", jsonStringArray(ids)), VoteRowSchema),
  );
  return rows.isOk() ? votesByStatus(rows.value, viewerId ?? "") : new Map();
};

/**
 * Record the viewer's votes, one per choice. Returns the choices that were
 * new: a vote already stored (a double submit) is not federated twice.
 */
export const recordRemotePollVotes = async (
  db: D1Database,
  statusId: string,
  accountId: string,
  votes: ReadonlyArray<Readonly<{ choice: number; activityId: string }>>,
): Promise<Result<ReadonlyArray<number>, RepositoryError>> => {
  const createdAt = nowIso();
  const batched = await runD1Batch(
    db,
    votes.map((vote) =>
      d1PrepareTyped(
        db,
        insertRemotePollOwnVoteSql(statusId, accountId, vote.choice, vote.activityId, createdAt),
      ),
    ),
  );
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(
    votes.flatMap((vote, index) =>
      (batched.value[index]?.meta.changes ?? 0) > 0 ? [vote.choice] : [],
    ),
  );
};

/** The author reported fresh counts, which now include the votes added locally. */
export const settleRemotePollVotes = async (db: D1Database, statusId: string): Promise<void> => {
  await runTyped(db, settleRemotePollOwnVotesSql(statusId));
};

/** A local account that voted on a remote poll which has since ended, and the poll's author. */
export type EndedRemotePollVoter = Readonly<{
  kind: "RemotePollVoter";
  statusId: string;
  accountId: string;
  actorUri: string;
}>;

const EndedRemotePollVoterRow = z.object({
  status_id: z.string(),
  account_id: z.string(),
  actor_uri: z.string(),
});

/** Voters of remote polls that ended by `now` and have not been told, oldest first. */
export const listEndedRemotePollVoters = async (
  db: D1Database,
  now: string,
  limit: number,
): Promise<Result<EndedRemotePollVoter[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      listEndedRemotePollVotersSql(now, limit),
      EndedRemotePollVoterRow,
    );
    return rows.map((row) => ({
      kind: "RemotePollVoter" as const,
      statusId: row.status_id,
      accountId: row.account_id,
      actorUri: row.actor_uri,
    }));
  });

/** Mark the voter as told; true for the one caller that marked it, so each voter is told once. */
export const claimRemotePollExpiryNotice = async (
  db: D1Database,
  notifiedAt: string,
  voter: EndedRemotePollVoter,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const result = await runTyped(
      db,
      claimRemotePollExpiryNoticeSql(notifiedAt, voter.statusId, voter.accountId),
    );
    return (result.meta.changes ?? 0) > 0;
  });
