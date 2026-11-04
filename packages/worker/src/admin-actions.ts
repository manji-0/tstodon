import type { LocalAccount } from "@tstodon/domain";
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
import { findReportById, listOpenReportIdsForTarget, setReportResolved } from "./report-store";

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
 * A moderation action on a local account. As in Mastodon, it resolves the
 * report that prompted it, or every open report against the account when
 * none is named.
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
  const account = await findAccountById(db, input.accountId);
  if (account.isErr()) {
    return err(account.error);
  }
  if (!account.value) {
    return err({ kind: "AccountNotFound" });
  }
  let reportIds: ReadonlyArray<string>;
  if (input.reportId === undefined) {
    const open = await listOpenReportIdsForTarget(db, account.value.id);
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
  const applied = await applyAction(db, account.value.id, input.type);
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
