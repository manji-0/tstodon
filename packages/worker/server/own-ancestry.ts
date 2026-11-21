import type { OwnAncestry } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { type RepositoryError, runD1 } from "./d1";
import { findLocalOwnAncestryTop, findRemoteOwnAncestryTop } from "./generated/prisma/sql";
import { queryTyped } from "./typed-sql";

/**
 * Parents climbed while they share the author. Mastodon stores the carried
 * `in_reply_to_account_id` on each status, so it never walks; a run longer
 * than this, or a forged loop, reads as leaving the author.
 */
export const OWN_ANCESTRY_STEP_LIMIT = 1000;

const RemoteTopRow = z.object({ depth: z.number(), in_reply_to_uri: z.string().nullable() });

/** Where the cached remote statuses above `statusId` by its own author lead. */
export const remoteOwnAncestry = async (
  db: D1Database,
  statusId: string,
): Promise<Result<OwnAncestry, RepositoryError>> =>
  (
    await runD1(() =>
      queryTyped(db, findRemoteOwnAncestryTop(statusId, OWN_ANCESTRY_STEP_LIMIT), RemoteTopRow),
    )
  ).map(([top]): OwnAncestry => {
    if (top === undefined) {
      return { kind: "NoParent" };
    }
    if (top.in_reply_to_uri !== null) {
      return { kind: "LeavesAuthor" };
    }
    return top.depth === 0 ? { kind: "NoParent" } : { kind: "ReachesRoot" };
  });

const LocalTopRow = z.object({
  in_reply_to_id: z.string().nullable(),
  in_reply_to_uri: z.string().nullable(),
});

/**
 * Where a local reply to `parentId`, by the parent's own author, leads: up
 * the parent's own statuses to a root, or away from its author.
 */
export const localOwnAncestryOfParent = async (
  db: D1Database,
  parentId: string,
): Promise<Result<OwnAncestry, RepositoryError>> =>
  (
    await runD1(() =>
      queryTyped(db, findLocalOwnAncestryTop(parentId, OWN_ANCESTRY_STEP_LIMIT), LocalTopRow),
    )
  ).map(([top]): OwnAncestry =>
    top !== undefined && top.in_reply_to_id === null && top.in_reply_to_uri === null
      ? { kind: "ReachesRoot" }
      : { kind: "LeavesAuthor" },
  );
