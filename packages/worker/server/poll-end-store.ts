import { assertNever } from "@tstodon/core";
import type { EndingPoll } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { type RepositoryError, runD1 } from "./d1";
import {
  claimLocalPollEnd as claimLocalPollEndSql,
  claimRemotePollEnd as claimRemotePollEndSql,
  findLocalPollEndQueued as findLocalPollEndQueuedSql,
  findRemotePollEndQueued as findRemotePollEndQueuedSql,
} from "./generated/prisma/sql";
import { queryTyped } from "./typed-sql";

const NullableIdRow = z.object({ id: z.string().nullable() });
const QueuedRow = z.object({ end_queued_at: z.string().nullable() });

/**
 * Record that the end of `poll` is queued for `at`. False when it already
 * is, the poll is gone, or (a remote poll) no local account voted on it.
 */
export const claimPollEnd = (
  db: D1Database,
  poll: EndingPoll,
  at: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const claim = (() => {
      switch (poll.kind) {
        case "LocalPoll":
          return claimLocalPollEndSql(at, poll.pollId, at);
        case "RemotePoll":
          return claimRemotePollEndSql(at, poll.statusId, at, poll.statusId);
        default:
          return assertNever(poll);
      }
    })();
    const rows = await queryTyped(db, claim, NullableIdRow);
    return rows.length > 0;
  });

/** The instant the end of `poll` is queued for; undefined when none is, or the poll is gone. */
export const findPollEndQueued = (
  db: D1Database,
  poll: EndingPoll,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const find = (() => {
      switch (poll.kind) {
        case "LocalPoll":
          return findLocalPollEndQueuedSql(poll.pollId);
        case "RemotePoll":
          return findRemotePollEndQueuedSql(poll.statusId);
        default:
          return assertNever(poll);
      }
    })();
    const [row] = await queryTyped(db, find, QueuedRow);
    return row?.end_queued_at ?? undefined;
  });
