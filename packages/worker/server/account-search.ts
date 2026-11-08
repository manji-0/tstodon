import type { LocalAccount, RemoteActor } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { searchableLocalAccounts, searchableRemoteActors } from "./account-presentation";
import { countSearchAccounts, type LocalAccountSearchScope, searchAccounts } from "./account-store";
import { suspendedDomains } from "./admin-domain-block-store";
import type { RepositoryError } from "./d1";
import { searchRemoteActors } from "./remote-actor-store";
import { federationAllowHosts } from "./runtime-config";

export type AccountSearchPage = Readonly<{ local: LocalAccount[]; remote: RemoteActor[] }>;

export type AccountSearchQuery = Readonly<{
  /** What local usernames and display names are matched against. */
  localTerms: string;
  /** What cached remote handles are matched against. */
  remoteTerms: string;
  /**
   * `FollowedBy` is `following=true`: only the local accounts the viewer
   * follows. Remote actors the viewer follows and the viewer's own account
   * are left out, unlike Mastodon's `first_degree`.
   */
  scope: LocalAccountSearchScope;
}>;

/**
 * Account search's non-exact results from `offset`, at most `limit`: the
 * matching local accounts, then the matching cached remote actors. `offset`
 * counts only the accounts search may list, so it is the number of results a
 * client already holds, which is what Mastodon's web app sends.
 *
 * The search queries leave out every account the presenter hides, so one
 * query per source reads the page, as Mastodon's search SQL does. The
 * presenter still filters what they return; the two agree, so it drops
 * nothing.
 */
export const searchAccountsPage = async (
  env: Env,
  query: AccountSearchQuery,
  limit: number,
  offset: number,
): Promise<Result<AccountSearchPage, RepositoryError>> => {
  if (limit <= 0) {
    return ok({ local: [], remote: [] });
  }
  const rows = await searchAccounts(env.DB, query.localTerms, query.scope, limit, offset);
  if (rows.isErr()) {
    return err(rows.error);
  }
  const local = await searchableLocalAccounts(env.DB, rows.value);
  if (local.isErr()) {
    return err(local.error);
  }
  if (query.scope.kind === "FollowedBy" || rows.value.length === limit) {
    return ok({ local: local.value, remote: [] });
  }
  // The remote results follow every listed local account.
  const localCount = await countSearchAccounts(env.DB, query.localTerms);
  if (localCount.isErr()) {
    return err(localCount.error);
  }
  const take = offset + limit - Math.max(offset, localCount.value);
  if (take <= 0) {
    return ok({ local: local.value, remote: [] });
  }
  const [allow, suspended] = await Promise.all([
    federationAllowHosts(env),
    suspendedDomains(env.DB),
  ]);
  const actors = await searchRemoteActors(
    env.DB,
    query.remoteTerms,
    { suspended, allow },
    take,
    Math.max(offset - localCount.value, 0),
  );
  if (actors.isErr()) {
    return err(actors.error);
  }
  return (await searchableRemoteActors(env, actors.value)).map((remote) => ({
    local: local.value,
    remote,
  }));
};
