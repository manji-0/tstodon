import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./repository-error";

/**
 * Delete up to `limit` of the oldest media rows no status, scheduled post or
 * edit history holds, uploaded before `createdBefore` (an ISO instant).
 * Resolves to how many rows went and the bucket keys they held.
 */
export type DeleteUnattachedMedia = (
  createdBefore: string,
  limit: number,
) => Promise<
  Result<Readonly<{ deleted: number; objectKeys: ReadonlyArray<string> }>, RepositoryError>
>;

/** Remove the bucket objects of media rows already deleted. */
export type DeleteMediaObjects = (objectKeys: ReadonlyArray<string>) => Promise<void>;

/** What one sweep pass did: rows deleted, and whether a full batch asks for another pass. */
export type MediaVacuumPass = Readonly<{ deleted: number; chained: boolean }>;

/** Mastodon's `Vacuum::MediaAttachmentsVacuum::TTL`: unattached media lives a day. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Rows per pass; a full batch chains another pass. */
const BATCH = 100;

export const MediaVacuum = {
  ttlMs: TTL_MS,
  batch: BATCH,

  /** Media uploaded before this instant and still unattached is removed. */
  cutoff: (nowMs: number): string => new Date(nowMs - TTL_MS).toISOString(),

  /**
   * One pass of the sweep: delete a batch of old unattached media rows, then
   * their objects (rows first, so no row names a missing object).
   */
  pass: async (
    deps: Readonly<{ deleteRows: DeleteUnattachedMedia; deleteObjects: DeleteMediaObjects }>,
    nowMs: number,
  ): Promise<Result<MediaVacuumPass, RepositoryError>> => {
    const removed = await deps.deleteRows(MediaVacuum.cutoff(nowMs), BATCH);
    if (removed.isErr()) {
      return err(removed.error);
    }
    if (removed.value.objectKeys.length > 0) {
      await deps.deleteObjects(removed.value.objectKeys);
    }
    const { deleted } = removed.value;
    return ok({ deleted, chained: deleted >= BATCH });
  },
} as const;
