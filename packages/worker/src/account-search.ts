import type { LocalAccount, RemoteActor } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { searchableLocalAccounts, searchableRemoteActors } from "./account-presentation";
import { searchAccounts } from "./account-store";
import type { RepositoryError } from "./d1";
import { searchRemoteActors } from "./remote-actor-store";

/** One ordered search source: up to `limit` matching rows from row `offset`. */
type Rows<T> = (limit: number, offset: number) => Promise<Result<T[], RepositoryError>>;

/** The rows among a batch the search lists, in order. */
type Shown<T> = (rows: ReadonlyArray<T>) => Promise<Result<T[], RepositoryError>>;

/** The shown items a scan took, and how much of its `skip` the source ran out before. */
type Scan<T> = Readonly<{ items: T[]; skipLeft: number }>;

const MIN_BATCH = 40;
const MAX_BATCH = 200;

/**
 * The `take` shown rows of `rows` after its first `skip` shown rows. Rows
 * are hidden after the query, so the scan reads further batches until the
 * page is full or the source runs out.
 */
const scanShown = async <T>(
  rows: Rows<T>,
  shown: Shown<T>,
  skip: number,
  take: number,
): Promise<Result<Scan<T>, RepositoryError>> => {
  const items: T[] = [];
  let skipLeft = skip;
  let rowOffset = 0;
  while (items.length < take) {
    const batch = Math.min(Math.max(skipLeft + take - items.length, MIN_BATCH), MAX_BATCH);
    const fetched = await rows(batch, rowOffset);
    if (fetched.isErr()) {
      return err(fetched.error);
    }
    const kept = await shown(fetched.value);
    if (kept.isErr()) {
      return err(kept.error);
    }
    const skipped = Math.min(skipLeft, kept.value.length);
    skipLeft -= skipped;
    items.push(...kept.value.slice(skipped, skipped + take - items.length));
    if (fetched.value.length < batch) {
      break;
    }
    rowOffset += batch;
  }
  return ok({ items, skipLeft });
};

export type AccountSearchPage = Readonly<{ local: LocalAccount[]; remote: RemoteActor[] }>;

export type AccountSearchQuery = Readonly<{
  /** What local usernames and display names are matched against. */
  localTerms: string;
  /** What cached remote handles are matched against. */
  remoteTerms: string;
  /**
   * `following=true`: the ids of the accounts the viewer follows. Only those
   * local accounts are listed, and no remote actor, since this instance keeps
   * no record of following one.
   */
  following: ReadonlySet<string> | undefined;
}>;

/**
 * Account search's non-exact results from `offset`, at most `limit`: the
 * matching local accounts, then the matching cached remote actors. `offset`
 * counts only the accounts search may list, so it is the number of results a
 * client already holds, which is what Mastodon's web app sends.
 */
export const searchAccountsPage = async (
  env: Env,
  query: AccountSearchQuery,
  limit: number,
  offset: number,
): Promise<Result<AccountSearchPage, RepositoryError>> => {
  const { following } = query;
  const local = await scanShown(
    (rowLimit, rowOffset) => searchAccounts(env.DB, query.localTerms, rowLimit, rowOffset),
    async (rows) =>
      (await searchableLocalAccounts(env.DB, rows)).map((accounts) =>
        following === undefined
          ? accounts
          : accounts.filter((account) => following.has(account.id)),
      ),
    offset,
    limit,
  );
  if (local.isErr()) {
    return err(local.error);
  }
  const take = limit - local.value.items.length;
  if (following !== undefined || take === 0) {
    return ok({ local: local.value.items, remote: [] });
  }
  const remote = await scanShown(
    (rowLimit, rowOffset) => searchRemoteActors(env.DB, query.remoteTerms, rowLimit, rowOffset),
    (rows) => searchableRemoteActors(env, rows),
    local.value.skipLeft,
    take,
  );
  return remote.map((scan) => ({ local: local.value.items, remote: scan.items }));
};
