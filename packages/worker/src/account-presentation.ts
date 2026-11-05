import {
  AccountPresentation,
  AccountStanding,
  Hostname,
  type InstanceIdentity,
  type LocalAccount,
  type RemoteActor,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { listAccountStandings } from "./account-moderation-store";
import { suspendedDomains } from "./admin-domain-block-store";
import type { RepositoryError } from "./d1";
import { listRemoteActorModerations } from "./remote-actor-moderation-store";
import { allowListAdmits, federationAllowHosts } from "./runtime-config";

/** Each local account's presentation, keyed by account id. */
export const localAccountPresentations = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, AccountPresentation>, RepositoryError>> =>
  (await listAccountStandings(db, accountIds)).map(
    (standings) =>
      new Map(
        accountIds.map((id) => [
          id,
          AccountPresentation.ofLocal(standings.get(id) ?? AccountStanding.inGoodStanding),
        ]),
      ),
  );

/** Each cached remote actor's presentation, keyed by actor URI. */
export const remoteAccountPresentations = async (
  env: Env,
  actors: ReadonlyArray<RemoteActor>,
): Promise<Result<ReadonlyMap<string, AccountPresentation>, RepositoryError>> => {
  const [allowHosts, blockedHosts, moderations] = await Promise.all([
    federationAllowHosts(env),
    suspendedDomains(env.DB),
    listRemoteActorModerations(
      env.DB,
      actors.map((actor) => actor.actorUri),
    ),
  ]);
  if (moderations.isErr()) {
    return err(moderations.error);
  }
  return ok(
    new Map(
      actors.map((actor) => [
        actor.actorUri,
        AccountPresentation.ofRemote({
          federates: allowListAdmits(allowHosts, actor.domain),
          domainSuspended: blockedHosts.has(Hostname.ofAuthority(actor.domain)),
          standing:
            moderations.value.get(actor.actorUri)?.standing ?? AccountStanding.inGoodStanding,
        }),
      ]),
    ),
  );
};

/** The local accounts account search may list, in order. */
export const searchableLocalAccounts = async (
  db: D1Database,
  accounts: ReadonlyArray<LocalAccount>,
): Promise<Result<LocalAccount[], RepositoryError>> =>
  (
    await localAccountPresentations(
      db,
      accounts.map((account) => account.id),
    )
  ).map((presentations) =>
    accounts.filter((account) => isSearchable(presentations.get(account.id))),
  );

/** The cached remote actors account search may list, in order. */
export const searchableRemoteActors = async (
  env: Env,
  actors: ReadonlyArray<RemoteActor>,
): Promise<Result<RemoteActor[], RepositoryError>> =>
  (await remoteAccountPresentations(env, actors)).map((presentations) =>
    actors.filter((actor) => isSearchable(presentations.get(actor.actorUri))),
  );

const isSearchable = (presentation: AccountPresentation | undefined): boolean =>
  presentation !== undefined && AccountPresentation.searchable(presentation);

/**
 * A rendered account as Mastodon's `REST::AccountSerializer` renders an
 * unavailable one: `suspended: true`, no profile text, images, emojis,
 * fields or `moved`, and every flag off. Counts and timestamps stay.
 */
const suspendedAccountDocument = (
  identity: InstanceIdentity,
  document: Readonly<Record<string, unknown>>,
): Record<string, unknown> => ({
  ...Object.fromEntries(Object.entries(document).filter(([key]) => key !== "moved")),
  display_name: "",
  note: "",
  avatar: identity.thumbnailUrl,
  avatar_static: identity.thumbnailUrl,
  header: identity.thumbnailUrl,
  header_static: identity.thumbnailUrl,
  avatar_description: "",
  header_description: "",
  locked: false,
  bot: false,
  discoverable: false,
  indexable: false,
  emojis: [],
  fields: [],
  suspended: true,
});

/**
 * The document an account read path answers for a rendered account, or
 * `undefined` when the account is hidden.
 */
export const presentedAccountDocument = (
  identity: InstanceIdentity,
  presentation: AccountPresentation,
  document: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  switch (presentation.kind) {
    case "Shown":
      return document;
    case "Suspended":
      return suspendedAccountDocument(identity, document);
    case "Hidden":
      return undefined;
  }
};
