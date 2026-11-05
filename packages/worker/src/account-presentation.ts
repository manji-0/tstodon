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
import type { AccountRef } from "./account-ref";
import { findAccountsByIds } from "./account-store";
import { suspendedDomains } from "./admin-domain-block-store";
import type { RepositoryError } from "./d1";
import { RemoteAccountId } from "./remote-account-id";
import { listRemoteActorModerations } from "./remote-actor-moderation-store";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { allowListAdmits, federationAllowHosts } from "./runtime-config";

/** How a local account among `accountIds` presents. */
const localPresenter = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Result<(accountId: string) => AccountPresentation, RepositoryError>> =>
  (await listAccountStandings(db, accountIds)).map(
    (standings) => (accountId) =>
      AccountPresentation.ofLocal(standings.get(accountId) ?? AccountStanding.inGoodStanding),
  );

/** How a remote actor among `actors` presents. */
const remotePresenter = async (
  env: Env,
  actors: ReadonlyArray<RemoteActor>,
): Promise<Result<(actor: RemoteActor) => AccountPresentation, RepositoryError>> => {
  if (actors.length === 0) {
    return ok(() => AccountPresentation.ofLocal(AccountStanding.inGoodStanding));
  }
  const [allowHosts, blockedHosts, moderations] = await Promise.all([
    federationAllowHosts(env),
    suspendedDomains(env.DB),
    listRemoteActorModerations(
      env.DB,
      actors.map((actor) => actor.actorUri),
    ),
  ]);
  return moderations.map(
    (byUri) => (actor) =>
      AccountPresentation.ofRemote({
        federates: allowListAdmits(allowHosts, actor.domain),
        domainSuspended: blockedHosts.has(Hostname.ofAuthority(actor.domain)),
        standing: byUri.get(actor.actorUri)?.standing ?? AccountStanding.inGoodStanding,
      }),
  );
};

/** Each local account's presentation, keyed by account id. */
export const localAccountPresentations = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, AccountPresentation>, RepositoryError>> =>
  (await localPresenter(db, accountIds)).map(
    (present) => new Map(accountIds.map((id) => [id, present(id)])),
  );

/** Each cached remote actor's presentation, keyed by actor URI. */
export const remoteAccountPresentations = async (
  env: Env,
  actors: ReadonlyArray<RemoteActor>,
): Promise<Result<ReadonlyMap<string, AccountPresentation>, RepositoryError>> =>
  (await remotePresenter(env, actors)).map(
    (present) => new Map(actors.map((actor) => [actor.actorUri, present(actor)])),
  );

/** One account's presentation. */
export const accountRefPresentation = async (
  env: Env,
  ref: AccountRef,
): Promise<Result<AccountPresentation, RepositoryError>> =>
  ref.kind === "LocalAccount"
    ? (await localPresenter(env.DB, [ref.account.id])).map((present) => present(ref.account.id))
    : (await remotePresenter(env, [ref.actor])).map((present) => present(ref.actor));

/**
 * The ids among `accountIds` (local ids or `r_…` ids) whose accounts are
 * available, as Mastodon's `Account.without_suspended`; ids that do not
 * resolve are left out.
 */
export const availableAccountIds = async (
  env: Env,
  accountIds: ReadonlyArray<string>,
): Promise<Result<ReadonlySet<string>, RepositoryError>> => {
  const local: string[] = [];
  const remote: string[] = [];
  for (const id of new Set(accountIds)) {
    const actorUri = RemoteAccountId.decode(id);
    if (actorUri.isOk()) {
      remote.push(actorUri.value);
    } else {
      local.push(id);
    }
  }
  const [locals, actors] = await Promise.all([
    findAccountsByIds(env.DB, local),
    findRemoteActorsByUris(env.DB, remote),
  ]);
  if (locals.isErr()) {
    return err(locals.error);
  }
  if (actors.isErr()) {
    return err(actors.error);
  }
  const [localPresent, remotePresent] = await Promise.all([
    localPresenter(env.DB, [...locals.value.keys()]),
    remotePresenter(env, [...actors.value.values()]),
  ]);
  if (localPresent.isErr()) {
    return err(localPresent.error);
  }
  if (remotePresent.isErr()) {
    return err(remotePresent.error);
  }
  return ok(
    new Set([
      ...[...locals.value.keys()].filter((id) =>
        AccountPresentation.available(localPresent.value(id)),
      ),
      ...[...actors.value.values()]
        .filter((actor) => AccountPresentation.available(remotePresent.value(actor)))
        .map((actor) => RemoteAccountId.encode(actor.actorUri)),
    ]),
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
    accounts.filter((account) => isAvailable(presentations.get(account.id))),
  );

/** The cached remote actors account search may list, in order. */
export const searchableRemoteActors = async (
  env: Env,
  actors: ReadonlyArray<RemoteActor>,
): Promise<Result<RemoteActor[], RepositoryError>> =>
  (await remoteAccountPresentations(env, actors)).map((presentations) =>
    actors.filter((actor) => isAvailable(presentations.get(actor.actorUri))),
  );

/**
 * Whose statuses a status renderer serves, by the author's presentation.
 * `available` is Mastodon's `StatusPolicy#show?`, which refuses an
 * unavailable author's status. `existing` serves any status Mastodon still
 * keeps, which is all but a suspended domain's: what a boost wraps, and the
 * status an interaction names. `any` is a moderator's report. Whichever
 * applies, an author that is not shown renders stripped.
 */
export const StatusAuthors = {
  available: AccountPresentation.available,
  existing: (presentation: AccountPresentation): boolean => presentation.kind !== "Hidden",
  any: (): boolean => true,
} as const satisfies Record<string, (presentation: AccountPresentation) => boolean>;

export type StatusAuthors = (typeof StatusAuthors)[keyof typeof StatusAuthors];

/** The rule for the status a boost served under `authors` wraps. */
export const boostedStatusAuthors = (authors: StatusAuthors): StatusAuthors =>
  authors === StatusAuthors.any ? StatusAuthors.any : StatusAuthors.existing;

const isAvailable = (presentation: AccountPresentation | undefined): boolean =>
  presentation !== undefined && AccountPresentation.available(presentation);

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
 * The document a record that names an account embeds for it: a shown account
 * in full, any other stripped.
 */
export const embeddedAccountDocument = (
  identity: InstanceIdentity,
  presentation: AccountPresentation,
  document: Record<string, unknown>,
): Record<string, unknown> =>
  presentation.kind === "Shown" ? document : suspendedAccountDocument(identity, document);

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
