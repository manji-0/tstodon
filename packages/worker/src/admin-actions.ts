import {
  type LocalAccount,
  type RemoteActorValue,
  RemoteActorModeration,
  type RemoteActorModerationAction,
} from "@tstodon/domain";
import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import {
  disabledAccountIds,
  mediaObjectKeysForAccount,
  pendingAccountIds,
  sensitizedAccountIds,
  setAccountDisabled,
  setAccountSensitized,
} from "./account-flag-store";
import {
  type AccountModeration,
  listAccountModerations,
  setAccountModeration,
} from "./account-moderation-store";
import { deleteAccount, findAccountById } from "./account-store";
import {
  getRemoteActorModeration,
  setRemoteActorModeration,
} from "./remote-actor-moderation-store";
import { findRemoteActorByUri } from "./remote-actor-store";
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
import { normalizeDomain } from "./domain-block-store";
import {
  findReportById,
  listOpenReportIdsForTarget,
  ReportParty,
  setReportResolved,
} from "./report-store";

/**
 * Moderation that both the admin API (`/api/v1/admin/*`) and the admin web
 * pages (`/admin/*`) perform, so the two cannot drift apart.
 */

/** A local account with the moderation state and flags an admin sees. */
export type AdminAccountState = Readonly<{
  account: LocalAccount;
  moderation: AccountModeration | null;
  sensitized: boolean;
  pending: boolean;
  disabled: boolean;
}>;

/** Each account's moderation state and flags, one query per table. */
export const adminAccountStates = async (
  db: D1Database,
  accounts: ReadonlyArray<LocalAccount>,
): Promise<Result<AdminAccountState[], RepositoryError>> => {
  const ids = accounts.map((account) => account.id);
  const [moderations, sensitized, pending, disabled] = await Promise.all([
    listAccountModerations(db, ids),
    sensitizedAccountIds(db, ids),
    pendingAccountIds(db, ids),
    disabledAccountIds(db, ids),
  ]);
  return Result.combine([moderations, sensitized, pending, disabled]).map(
    ([moderationOf, sensitizedIds, pendingIds, disabledIds]) =>
      accounts.map((account) => ({
        account,
        moderation: moderationOf.get(account.id) ?? null,
        sensitized: sensitizedIds.has(account.id),
        pending: pendingIds.has(account.id),
        disabled: disabledIds.has(account.id),
      })),
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

/** Apply one moderation transition to a remote actor and store the result. */
export const moderateRemoteActor = async (
  db: D1Database,
  actorUri: string,
  action: RemoteActorModerationAction,
): Promise<Result<void, RepositoryError>> => {
  const current = await getRemoteActorModeration(db, actorUri);
  if (current.isErr()) {
    return err(current.error);
  }
  return setRemoteActorModeration(db, actorUri, RemoteActorModeration.apply(current.value, action));
};

/** Mastodon's `POST /api/v1/admin/accounts/:id/action` types. */
export const AccountActionTypeSchema = z.union([
  z.literal("none"),
  z.literal("sensitive"),
  z.literal("disable"),
  z.literal("silence"),
  z.literal("suspend"),
]);

export type AccountActionType = z.infer<typeof AccountActionTypeSchema>;

export type AccountActionError =
  | Readonly<{ kind: "AccountNotFound" }>
  | Readonly<{ kind: "NotApplicable" }>
  | Readonly<{ kind: "ReportNotFound" }>
  | RepositoryError;

const applyAction = async (
  db: D1Database,
  accountId: string,
  type: AccountActionType,
): Promise<Result<void, RepositoryError>> => {
  switch (type) {
    case "none":
      return ok(undefined);
    case "sensitive":
      return setAccountSensitized(db, accountId, true);
    case "disable":
      return setAccountDisabled(db, accountId, true);
    case "silence":
      return setAccountModeration(db, accountId, "Silenced");
    case "suspend":
      return setAccountModeration(db, accountId, "Suspended");
  }
};

/**
 * What each action type does to a remote actor. It has no login to `disable`,
 * which Mastodon's remote accounts do not take either.
 */
const REMOTE_ACTION: Readonly<
  Record<AccountActionType, RemoteActorModerationAction | "none" | "NotApplicable">
> = {
  none: "none",
  sensitive: "sensitize",
  silence: "silence",
  suspend: "suspend",
  disable: "NotApplicable",
};

/**
 * A moderation action on a local account or a remote actor (`r_…` id). As in
 * Mastodon, it resolves the report that prompted it, or every open report
 * against the account when none is named.
 */
export const takeAccountAction = async (
  db: D1Database,
  input: Readonly<{
    accountId: string;
    type: AccountActionType;
    reportId: string | undefined;
    moderatorId: string;
  }>,
): Promise<Result<void, AccountActionError>> => {
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
    if (REMOTE_ACTION[input.type] === "NotApplicable") {
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
  const remoteAction = REMOTE_ACTION[input.type];
  const applied =
    target.kind === "Local"
      ? await applyAction(db, target.accountId, input.type)
      : remoteAction === "none" || remoteAction === "NotApplicable"
        ? ok(undefined)
        : await moderateRemoteActor(db, target.actorUri, remoteAction);
  if (applied.isErr()) {
    return err(applied.error);
  }
  for (const reportId of reportIds) {
    const resolved = await setReportResolved(db, reportId, input.moderatorId);
    if (resolved.isErr()) {
      return err(resolved.error);
    }
  }
  return ok(undefined);
};

/**
 * Delete a local account and everything it owns (Mastodon's
 * `DeleteAccountService`): its bucket objects first, then the rows, which
 * cascade from `accounts`. `false` when there was no such account.
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
  return deleteAccount(env.DB, accountId);
};

export type DomainBlockSettings = Omit<DomainBlockInput, "domain">;

export type CreateDomainBlockError =
  | Readonly<{ kind: "DomainRequired" }>
  | Readonly<{ kind: "OwnDomain" }>
  | Readonly<{ kind: "AlreadyBlocked" }>
  | RepositoryError;

const savedBlock = async (
  db: D1Database,
  id: string,
): Promise<Result<DomainBlockRow | undefined, RepositoryError>> => {
  const block = await findDomainBlockById(db, id);
  if (block.isOk() && block.value && block.value.reject_media !== 0) {
    await clearRemoteMediaForDomain(db, block.value.domain);
  }
  return block;
};

/** Block a domain this server has not blocked yet; never its own. */
export const createDomainBlock = async (
  db: D1Database,
  ownDomain: string,
  rawDomain: string,
  settings: DomainBlockSettings,
): Promise<Result<DomainBlockRow | undefined, CreateDomainBlockError>> => {
  const domain = normalizeDomain(rawDomain);
  if (domain.length === 0) {
    return err({ kind: "DomainRequired" });
  }
  if (domain === ownDomain.toLowerCase()) {
    return err({ kind: "OwnDomain" });
  }
  const existing = await findDomainBlockByDomain(db, domain);
  if (existing.isErr()) {
    return err(existing.error);
  }
  if (existing.value) {
    return err({ kind: "AlreadyBlocked" });
  }
  const created = await insertDomainBlock(db, { domain, ...settings });
  if (created.isErr()) {
    return err(created.error);
  }
  return savedBlock(db, created.value);
};

/** Change an existing domain block; `undefined` when there is none. */
export const changeDomainBlock = async (
  db: D1Database,
  id: string,
  settings: DomainBlockSettings,
): Promise<Result<DomainBlockRow | undefined, RepositoryError>> => {
  const updated = await updateDomainBlock(db, id, settings);
  if (updated.isErr()) {
    return err(updated.error);
  }
  return updated.value ? savedBlock(db, id) : ok(undefined);
};
