import {
  AccountActionType,
  type LocalAccount,
  type LocalAccountActionEffect,
  LocalAccountModeration,
  type RemoteAccountActionEffect,
  type LocalAccountModerationAction,
  type LocalAccountModerationValue,
  type RemoteActorValue,
  RemoteActorModeration,
  type RemoteActorModerationAction,
  Hostname,
  ReportResolution,
} from "@tstodon/domain";
import { nowIso } from "./clock";
import { err, ok, type Result } from "neverthrow";
import { mediaObjectKeysForAccount } from "./account-flag-store";
import { MediaObjectKind } from "./media-keys";
import {
  findLocalAccountModeration,
  listLocalAccountModerations,
  saveLocalAccountModeration,
} from "./account-moderation-store";
import { deleteAccount, findAccountById } from "./account-store";
import {
  getRemoteActorModeration,
  setRemoteActorModeration,
} from "./remote-actor-moderation-store";
import { findRemoteActorByUri } from "./remote-actor-store";
import { severAndNotify } from "./severance";
import {
  clearRemoteMediaForDomain,
  type DomainBlockInput,
  type DomainBlockRow,
  findDomainBlockByDomain,
  findDomainBlockById,
  insertDomainBlock,
  updateDomainBlock,
} from "./admin-domain-block-store";
import type { RepositoryError } from "./d1";
import {
  findReportById,
  listOpenReportIdsForTarget,
  ReportParty,
  setReportResolution,
} from "./report-store";

/**
 * Moderation that both the admin API (`/api/v1/admin/*`) and the admin web
 * pages (`/admin/*`) perform, so the two cannot drift apart.
 */

/** A local account with the moderation state an admin sees. */
export type AdminAccountState = Readonly<{
  account: LocalAccount;
  moderation: LocalAccountModerationValue;
}>;

/** Each account's moderation state, in one query. */
export const adminAccountStates = async (
  db: D1Database,
  accounts: ReadonlyArray<LocalAccount>,
): Promise<Result<AdminAccountState[], RepositoryError>> => {
  const moderations = await listLocalAccountModerations(
    db,
    accounts.map((account) => account.id),
  );
  return moderations.map((moderationOf) =>
    accounts.map((account) => ({
      account,
      moderation: moderationOf.get(account.id) ?? LocalAccountModeration.inGoodStanding,
    })),
  );
};

/** Apply one moderation transition to a local account and store the result. */
export const moderateLocalAccount = async (
  db: D1Database,
  accountId: string,
  action: LocalAccountModerationAction,
): Promise<Result<void, RepositoryError>> => {
  const current = await findLocalAccountModeration(db, accountId);
  if (current.isErr()) {
    return err(current.error);
  }
  return saveLocalAccountModeration(
    db,
    accountId,
    LocalAccountModeration.apply(current.value, action),
  );
};

/** The local account at `id` with its moderation state, if there is one. */
export const findAdminAccount = async (
  db: D1Database,
  id: string,
): Promise<Result<AdminAccountState | undefined, RepositoryError>> => {
  const account = await findAccountById(db, id);
  if (account.isErr()) {
    return err(account.error);
  }
  if (!account.value) {
    return ok(undefined);
  }
  const states = await adminAccountStates(db, [account.value]);
  return states.map((found) => found[0]);
};

/** A remote actor with the moderation an admin applied to it. */
export type AdminRemoteActorState = Readonly<{
  actor: RemoteActorValue;
  moderation: RemoteActorModeration;
}>;

/** The cached remote actor at `actorUri` with its moderation, if there is one. */
export const findAdminRemoteActor = async (
  db: D1Database,
  actorUri: string,
): Promise<Result<AdminRemoteActorState | undefined, RepositoryError>> => {
  const actor = await findRemoteActorByUri(db, actorUri);
  if (actor.isErr()) {
    return err(actor.error);
  }
  const found = actor.value;
  if (!found) {
    return ok(undefined);
  }
  const moderation = await getRemoteActorModeration(db, actorUri);
  return moderation.map((standing) => ({ actor: found, moderation: standing }));
};

/**
 * Apply one moderation transition to a remote actor and store the result.
 * Suspending an actor removes the follows between it and local accounts
 * (`account_suspension` in `/severed_relationships`).
 */
export const moderateRemoteActor = async (
  env: Env,
  actorUri: string,
  action: RemoteActorModerationAction,
): Promise<Result<void, RepositoryError>> => {
  const current = await getRemoteActorModeration(env.DB, actorUri);
  if (current.isErr()) {
    return err(current.error);
  }
  const next = RemoteActorModeration.apply(current.value, action);
  const stored = await setRemoteActorModeration(env.DB, actorUri, next);
  if (
    stored.isErr() ||
    next.standing.kind !== "Suspended" ||
    current.value.standing.kind === "Suspended"
  ) {
    return stored;
  }
  const actor = await findRemoteActorByUri(env.DB, actorUri);
  if (actor.isErr()) {
    return err(actor.error);
  }
  if (!actor.value) {
    return stored;
  }
  return severAndNotify(env, {
    scope: { kind: "Actor", actorUri },
    type: "account_suspension",
    targetName: `${actor.value.username}@${actor.value.domain}`,
  });
};

export type AccountActionError =
  | Readonly<{ kind: "AccountNotFound" }>
  | Readonly<{ kind: "NotApplicable" }>
  | Readonly<{ kind: "ReportNotFound" }>
  | RepositoryError;

const applyLocalEffect = async (
  db: D1Database,
  accountId: string,
  effect: LocalAccountActionEffect,
): Promise<Result<void, RepositoryError>> =>
  effect.kind === "Moderate" ? moderateLocalAccount(db, accountId, effect.action) : ok(undefined);

const applyRemoteEffect = async (
  env: Env,
  actorUri: string,
  effect: RemoteAccountActionEffect,
): Promise<Result<void, RepositoryError>> =>
  effect.kind === "Moderate" ? moderateRemoteActor(env, actorUri, effect.action) : ok(undefined);

/**
 * A moderation action on a local account or a remote actor (`r_…` id). As in
 * Mastodon, it resolves the report that prompted it, or every open report
 * against the account when none is named.
 */
export const takeAccountAction = async (
  env: Env,
  input: Readonly<{
    accountId: string;
    type: AccountActionType;
    reportId: string | undefined;
    moderatorId: string;
  }>,
): Promise<Result<void, AccountActionError>> => {
  const db = env.DB;
  const requested = ReportParty.ofAccountId(input.accountId);
  let target: ReportParty;
  if (requested.kind === "Local") {
    const account = await findAccountById(db, requested.accountId);
    if (account.isErr()) {
      return err(account.error);
    }
    if (!account.value) {
      return err({ kind: "AccountNotFound" });
    }
    target = { kind: "Local", accountId: account.value.id };
  } else {
    const actor = await findRemoteActorByUri(db, requested.actorUri);
    if (actor.isErr()) {
      return err(actor.error);
    }
    if (!actor.value) {
      return err({ kind: "AccountNotFound" });
    }
    if (AccountActionType.remoteEffect(input.type).kind === "NotApplicable") {
      return err({ kind: "NotApplicable" });
    }
    target = requested;
  }
  let reportIds: ReadonlyArray<string>;
  if (input.reportId === undefined) {
    const open = await listOpenReportIdsForTarget(db, target);
    if (open.isErr()) {
      return err(open.error);
    }
    reportIds = open.value;
  } else {
    const report = await findReportById(db, input.reportId);
    if (report.isErr()) {
      return err(report.error);
    }
    if (!report.value) {
      return err({ kind: "ReportNotFound" });
    }
    reportIds = [report.value.id];
  }
  const applied =
    target.kind === "Local"
      ? await applyLocalEffect(db, target.accountId, AccountActionType.localEffect(input.type))
      : await applyRemoteEffect(env, target.actorUri, AccountActionType.remoteEffect(input.type));
  if (applied.isErr()) {
    return err(applied.error);
  }
  const resolution = ReportResolution.resolved(input.moderatorId, nowIso());
  for (const reportId of reportIds) {
    const resolved = await setReportResolution(db, reportId, resolution);
    if (resolved.isErr()) {
      return err(resolved.error);
    }
  }
  return ok(undefined);
};

/** Delete every bucket object under `prefix`, a page of up to 1,000 at a time. */
const deleteObjectsUnder = async (bucket: R2Bucket, prefix: string): Promise<void> => {
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
};

/**
 * Delete a local account and everything it owns (Mastodon's
 * `DeleteAccountService`): its bucket objects first, then the rows, which
 * cascade from `accounts`. `false` when there was no such account. Last, it
 * deletes whatever is left under the account's attachment prefix: a copy the
 * rekey job pointed a row at after the keys were listed, or one it could not
 * confirm. A copy the job makes after the rows are gone, it deletes itself.
 */
export const purgeAccount = async (
  env: Env,
  accountId: string,
): Promise<Result<boolean, RepositoryError>> => {
  const objects = await mediaObjectKeysForAccount(env.DB, accountId);
  if (objects.isErr()) {
    return err(objects.error);
  }
  for (const objectKey of objects.value) {
    await env.MEDIA.delete(objectKey);
  }
  const deleted = await deleteAccount(env.DB, accountId);
  if (deleted.isOk()) {
    await deleteObjectsUnder(env.MEDIA, `${MediaObjectKind.Attachment}/${accountId}/`);
  }
  return deleted;
};

export type DomainBlockSettings = Omit<DomainBlockInput, "domain">;

export type CreateDomainBlockError =
  | Readonly<{ kind: "DomainRequired" }>
  | Readonly<{ kind: "OwnDomain" }>
  | Readonly<{ kind: "AlreadyBlocked" }>
  | RepositoryError;

/**
 * The block as saved, once its effects are carried out: remote media dropped
 * for `reject_media`, and the follows between local accounts and the server
 * removed for a `suspend` (`domain_block` in `/severed_relationships`).
 */
const savedBlock = async (
  env: Env,
  id: string,
): Promise<Result<DomainBlockRow | undefined, RepositoryError>> => {
  const block = await findDomainBlockById(env.DB, id);
  if (block.isErr() || !block.value) {
    return block;
  }
  const host = Hostname.ofAuthority(block.value.domain);
  if (block.value.reject_media !== 0) {
    await clearRemoteMediaForDomain(env.DB, host);
  }
  if (block.value.severity === "suspend") {
    const severed = await severAndNotify(env, {
      scope: { kind: "Domain", domain: host },
      type: "domain_block",
      targetName: block.value.domain,
    });
    if (severed.isErr()) {
      return err(severed.error);
    }
  }
  return block;
};

/** Block a domain this server has not blocked yet; never its own. */
export const createDomainBlock = async (
  env: Env,
  ownDomain: string,
  rawDomain: string,
  settings: DomainBlockSettings,
): Promise<Result<DomainBlockRow | undefined, CreateDomainBlockError>> => {
  const domain = Hostname.fromInput(rawDomain);
  if (domain === undefined) {
    return err({ kind: "DomainRequired" });
  }
  if (domain === ownDomain.toLowerCase()) {
    return err({ kind: "OwnDomain" });
  }
  const existing = await findDomainBlockByDomain(env.DB, domain);
  if (existing.isErr()) {
    return err(existing.error);
  }
  if (existing.value) {
    return err({ kind: "AlreadyBlocked" });
  }
  const created = await insertDomainBlock(env.DB, { domain, ...settings });
  if (created.isErr()) {
    return err(created.error);
  }
  return savedBlock(env, created.value);
};

/** Change an existing domain block; `undefined` when there is none. */
export const changeDomainBlock = async (
  env: Env,
  id: string,
  settings: DomainBlockSettings,
): Promise<Result<DomainBlockRow | undefined, RepositoryError>> => {
  const updated = await updateDomainBlock(env.DB, id, settings);
  if (updated.isErr()) {
    return err(updated.error);
  }
  return updated.value ? savedBlock(env, id) : ok(undefined);
};
