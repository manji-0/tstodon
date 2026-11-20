import type { RemoteStatus } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { suspendedDomains } from "./admin-domain-block-store";
import { type RepositoryError, runD1 } from "./d1";
import { claimRemotePollRefresh as claimRemotePollRefreshSql } from "./generated/prisma/sql";
import { instanceActorFetchSigner } from "./instance-actor";
import { findRemoteActorByUri } from "./remote-actor-store";
import { findRemoteStatusById } from "./remote-status-store";
import { applyRemoteUpdate } from "./remote-update";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";
import { queryTyped } from "./typed-sql";

/** Mastodon's `Poll::MAKE_FETCH_HAPPEN`: a poll fetched this recently is not fetched again. */
const REFETCH_AFTER_MS = 60_000;

const ClaimedRow = z.object({ id: z.string() });

/**
 * Claim the poll of a remote status for a fetch when it may be stale, as
 * Mastodon's `Poll#possibly_stale?`: never fetched, or last fetched more than
 * a minute ago and before it ended. The claim records the fetch, so readers
 * that come in the meantime do not fetch it too.
 */
const claimRemotePollRefresh = (
  db: D1Database,
  statusId: string,
  now: number,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      claimRemotePollRefreshSql(
        new Date(now).toISOString(),
        statusId,
        new Date(now - REFETCH_AFTER_MS).toISOString(),
      ),
      ClaimedRow,
    );
    return rows.length > 0;
  });

/**
 * The remote status a signed-in reader of its poll is shown: fetched again
 * from its server first when the poll may be stale, as Mastodon's
 * `PollsController#refresh_poll` runs `FetchRemotePollService`, which applies
 * the document as an `Update` of the note. The fetch is signed by the
 * instance actor, not the reader. A fetch that fails leaves the stored poll.
 */
export const refreshRemotePoll = async (
  env: Env,
  status: RemoteStatus,
): Promise<Result<RemoteStatus, RepositoryError>> => {
  const claimed = await claimRemotePollRefresh(env.DB, status.id, Date.now());
  if (claimed.isErr() || !claimed.value) {
    return claimed.map(() => status);
  }
  const author = await findRemoteActorByUri(env.DB, status.actorUri);
  if (author.isErr()) {
    return err(author.error);
  }
  const identity = parseInstanceIdentity(env);
  if (identity.isErr() || author.value === undefined) {
    return ok(status);
  }
  const applied = await applyRemoteUpdate(env, identity.value, author.value, status.objectUri, {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: await suspendedDomains(env.DB),
    fetchSigner: instanceActorFetchSigner(env.DB, identity.value),
  });
  if (applied.isErr()) {
    return applied.map(() => status);
  }
  const refreshed = await findRemoteStatusById(env.DB, status.id);
  return refreshed.map((found) => found ?? status);
};
