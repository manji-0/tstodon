import { schemaResult } from "@tstodon/core";
import type { RemoteStatus } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { suspendedDomains } from "./admin-domain-block-store";
import { type RepositoryError, runD1 } from "./d1";
import { fetchActivityJson } from "./federated-fetch";
import {
  claimRemotePollRefresh as claimRemotePollRefreshSql,
  findRemotePollFetchedAt as findRemotePollFetchedAtSql,
  releaseRemotePollRefresh as releaseRemotePollRefreshSql,
} from "./generated/prisma/sql";
import { instanceActorFetchSigner } from "./instance-actor";
import { findRemoteActorByUri } from "./remote-actor-store";
import { findRemoteStatusById } from "./remote-status-store";
import { applyRemoteUpdate } from "./remote-update";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";
import { queryTyped, runTyped } from "./typed-sql";

/** Mastodon's `Poll::MAKE_FETCH_HAPPEN`: a poll fetched this recently is not fetched again. */
const REFETCH_AFTER_MS = 60_000;

const ClaimedRow = z.object({ id: z.string() });
const FetchedAtRow = z.object({ poll_fetched_at: z.string().nullable() });
const parseNamedObject = schemaResult(z.looseObject({ id: z.string() }));

/** A claimed refresh: the fetch time it replaced, and the one it wrote. */
type Claim = Readonly<{ previous: string | null; claimedAt: string }>;

/**
 * Claim the poll of a remote status for a fetch when it may be stale, as
 * Mastodon's `Poll#possibly_stale?`: never fetched, or last fetched more than
 * a minute ago and before it ended. The claim records the fetch, so readers
 * that come in the meantime do not fetch it too; a refresh that fails puts
 * the previous time back ({@link releaseClaim}).
 */
const claimRemotePollRefresh = (
  db: D1Database,
  statusId: string,
  now: number,
): Promise<Result<Claim | undefined, RepositoryError>> =>
  runD1(async () => {
    const [stored] = await queryTyped(db, findRemotePollFetchedAtSql(statusId), FetchedAtRow);
    if (stored === undefined) {
      return undefined;
    }
    const claim = { previous: stored.poll_fetched_at, claimedAt: new Date(now).toISOString() };
    const rows = await queryTyped(
      db,
      claimRemotePollRefreshSql(
        claim.claimedAt,
        statusId,
        new Date(now - REFETCH_AFTER_MS).toISOString(),
        claim.previous,
      ),
      ClaimedRow,
    );
    return rows.length > 0 ? claim : undefined;
  });

/**
 * Mastodon records a fetch only once the document updated the poll
 * (`update_poll!`): put back the time the claim replaced, unless an
 * `Update` recorded one since.
 */
const releaseClaim = async (db: D1Database, statusId: string, claim: Claim): Promise<void> => {
  await runD1(() =>
    runTyped(db, releaseRemotePollRefreshSql(claim.previous, statusId, claim.claimedAt)),
  );
};

/**
 * Fetch the note of `status` from its server and apply it as an `Update`, as
 * Mastodon's `FetchRemotePollService` (`fetch_resource` checks the document
 * is the note it asked for). True when the document was applied.
 */
const fetchAndApply = async (
  env: Env,
  status: RemoteStatus,
): Promise<Result<boolean, RepositoryError>> => {
  const author = await findRemoteActorByUri(env.DB, status.actorUri);
  if (author.isErr()) {
    return err(author.error);
  }
  const identity = parseInstanceIdentity(env);
  if (identity.isErr() || author.value === undefined) {
    return ok(false);
  }
  const options = {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: await suspendedDomains(env.DB),
    fetchSigner: instanceActorFetchSigner(env.DB, identity.value),
  };
  const fetched = await fetchActivityJson(identity.value, status.objectUri, options);
  const document = fetched.isOk() ? parseNamedObject(fetched.value) : undefined;
  if (document === undefined || document.isErr() || document.value.id !== status.objectUri) {
    return ok(false);
  }
  const applied = await applyRemoteUpdate(
    env,
    identity.value,
    author.value,
    document.value,
    options,
  );
  if (applied.isErr()) {
    return applied.error.kind === "RepositoryError" ? err(applied.error) : ok(false);
  }
  return ok(true);
};

/**
 * The remote status a signed-in reader of its poll is shown: fetched again
 * from its server first when the poll may be stale, as Mastodon's
 * `PollsController#refresh_poll` runs `FetchRemotePollService`, which applies
 * the document as an `Update` of the note. The fetch is signed by the
 * instance actor, not the reader. A fetch that fails leaves the stored poll,
 * still stale.
 */
export const refreshRemotePoll = async (
  env: Env,
  status: RemoteStatus,
): Promise<Result<RemoteStatus, RepositoryError>> => {
  const claimed = await claimRemotePollRefresh(env.DB, status.id, Date.now());
  if (claimed.isErr()) {
    return err(claimed.error);
  }
  if (claimed.value === undefined) {
    return ok(status);
  }
  const applied = await fetchAndApply(env, status);
  if (applied.isErr() || !applied.value) {
    await releaseClaim(env.DB, status.id, claimed.value);
    return applied.map(() => status);
  }
  const refreshed = await findRemoteStatusById(env.DB, status.id);
  return refreshed.map((found) => found ?? status);
};
