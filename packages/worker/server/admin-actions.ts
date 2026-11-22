import {
  AccountActionType,
  AccountStanding,
  type LocalAccount,
  type LocalAccountActionEffect,
  LocalAccountModeration,
  type RemoteAccountActionEffect,
  type LocalAccountModerationAction,
  type LocalAccountModerationValue,
  type RemoteActorValue,
  RemoteActorModeration,
  type RemoteActorModerationAction,
  DomainBlockPolicy,
  Hostname,
  ReportResolution,
} from "@tstodon/domain";
import { announceActorDeleted, readDepartingActor } from "./actor-delete";
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
import { departedAccountActivityStatements } from "./outbox-store";
import { findRemoteActorByUri } from "./remote-actor-store";
import { federateActorChange } from "./local-actor";
import { parseInstanceIdentity } from "./runtime-config";
import { severAndNotify } from "./severance";
import { severSuspendedActor } from "./suspended-actor-severance";
import {
  clearRemoteMediaForDomain,
  type DomainBlockInput,
  type DomainBlockRow,
  findDomainBlockByDomain,
  findDomainBlockById,
  findDomainBlockRule,
  deleteDomainBlock,
  insertDomainBlock,
  updateDomainBlock,
} from "./admin-domain-block-store";
import {
  liftDomainBlockLimits,
  listDomainBlockStandings,
  startDomainBlockLimits,
} from "./domain-block-limits";
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

/**
 * Apply one moderation transition to a local account and store the result.
 * A suspension, or its lifting, federates as an actor `Update`, with
 * `suspended` or the profile back, as Mastodon's `SuspendAccountService` and
 * `UnsuspendAccountService` (`distribute_update_actor!`).
 */
export const moderateLocalAccount = async (
  env: Env,
  accountId: string,
  action: LocalAccountModerationAction,
): Promise<Result<void, RepositoryError>> => {
  const current = await findLocalAccountModeration(env.DB, accountId);
  if (current.isErr()) {
    return err(current.error);
  }
  const next = LocalAccountModeration.apply(current.value, action);
  const stored = await saveLocalAccountModeration(env.DB, accountId, next);
  const wasSuspended = current.value.standing.kind === "Suspended";
  if (stored.isErr() || wasSuspended === (next.standing.kind === "Suspended")) {
    return stored;
  }
  const identity = parseInstanceIdentity(env);
  const account = await findAccountById(env.DB, accountId);
  if (identity.isOk() && account.isOk() && account.value) {
    await federateActorChange(env, identity.value, account.value, "Suspension");
  }
  return stored;
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

/**
 * A remote actor with the moderation an admin sees: its own, with the
 * standing the instance domain blocks hold on it when that one is stronger.
 */
export type AdminRemoteActorState = Readonly<{
  actor: RemoteActorValue;
  moderation: RemoteActorModeration;
}>;

/**
 * Each actor's moderation as an admin sees it: Mastodon's `silenced?` and
 * `suspended?` read `silenced_at` / `suspended_at`, which a domain block
 * sets on the accounts it covers as an admin's own action does.
 */
export const withDomainBlockStandings = async (
  db: D1Database,
  moderations: ReadonlyMap<string, RemoteActorModeration>,
  actorUris: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, RemoteActorModeration>, RepositoryError>> =>
  (await listDomainBlockStandings(db, actorUris)).map(
    (standings) =>
      new Map(
        actorUris.map((uri) => {
          const own = moderations.get(uri) ?? RemoteActorModeration.inGoodStanding;
          const domain = standings.get(uri) ?? AccountStanding.inGoodStanding;
          return [uri, { ...own, standing: AccountStanding.stronger(own.standing, domain) }];
        }),
      ),
  );

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
  const own = await getRemoteActorModeration(db, actorUri);
  if (own.isErr()) {
    return err(own.error);
  }
  const seen = await withDomainBlockStandings(db, new Map([[actorUri, own.value]]), [actorUri]);
  return seen.map((byUri) => ({
    actor: found,
    moderation: byUri.get(actorUri) ?? own.value,
  }));
};

/**
 * Apply one moderation transition to a remote actor and store the result.
 * Unsilencing or unsuspending also lifts the silence or suspension an
 * instance domain block holds on the actor, as Mastodon's `unsilence!` /
 * `unsuspend!` clear `silenced_at` / `suspended_at` whoever set them.
 * Suspending an actor removes the follows between it and local accounts
 * (`account_suspension` in `/severed_relationships`) and tells its server
 * with a `Reject(Follow)` or `Undo(Follow)` for each, in pages
 * (`severSuspendedActor`). Lifting the suspension restores none of them.
 * Deviation: Mastodon keeps local accounts' follows of a suspended actor
 * (they come back with an unsuspension) and only rejects the actor's own
 * follows; tstodon severs both ways.
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
  if (stored.isOk() && (action === "unsilence" || action === "unsuspend")) {
    return liftDomainBlockLimits(env.DB, actorUri, action === "unsilence" ? "silence" : "suspend");
  }
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
  if (actor.value) {
    await severSuspendedActor(env, actor.value);
  }
  return stored;
};

export type AccountActionError =
  | Readonly<{ kind: "AccountNotFound" }>
  | Readonly<{ kind: "NotApplicable" }>
  | Readonly<{ kind: "ReportNotFound" }>
  | RepositoryError;

const applyLocalEffect = async (
  env: Env,
  accountId: string,
  effect: LocalAccountActionEffect,
): Promise<Result<void, RepositoryError>> =>
  effect.kind === "Moderate" ? moderateLocalAccount(env, accountId, effect.action) : ok(undefined);

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
      ? await applyLocalEffect(env, target.accountId, AccountActionType.localEffect(input.type))
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
 * cascade from `accounts`. The `Delete` of its actor, for the remote servers
 * that know it (`actor-delete.ts`), is stored in the batch that deletes the
 * rows and delivered after it: nothing is sent unless the rows are gone, so
 * a deletion that fails part way can be tried again, and a deletion that
 * commits always has its `Delete`. `false` when there was no such account.
 * Last, it
 * deletes whatever is left under the account's attachment prefix: a copy the
 * rekey job pointed a row at after the keys were listed, or one it could not
 * confirm. A copy the job makes after the rows are gone, it deletes itself.
 */
export const purgeAccount = async (
  env: Env,
  accountId: string,
): Promise<Result<boolean, RepositoryError>> => {
  const departing = await readDepartingActor(env, accountId);
  if (departing.isErr()) {
    return err(departing.error);
  }
  const objects = await mediaObjectKeysForAccount(env.DB, accountId);
  if (objects.isErr()) {
    return err(objects.error);
  }
  for (const objectKey of objects.value) {
    await env.MEDIA.delete(objectKey);
  }
  const deleted = await deleteAccount(
    env.DB,
    accountId,
    departing.value ? departedAccountActivityStatements(departing.value) : [],
  );
  if (deleted.isOk() && deleted.value && departing.value) {
    await announceActorDeleted(env, departing.value);
  }
  if (deleted.isOk()) {
    await deleteObjectsUnder(env.MEDIA, `${MediaObjectKind.Attachment}/${accountId}/`);
  }
  return deleted;
};

export type DomainBlockSettings = Omit<DomainBlockInput, "domain">;

/** A new block's settings; `severity` is `undefined` when the request named none Mastodon knows. */
export type DomainBlockRequest = Omit<DomainBlockSettings, "severity"> &
  Readonly<{ severity: DomainBlockSettings["severity"] | undefined }>;

/** A failed validation of a new block, in the order `DomainBlock` declares them. */
export type DomainBlockInvalidity = "SeverityNotIncluded" | "DomainBlank" | "DomainInvalid";

export type CreateDomainBlockError =
  | Readonly<{ kind: "ValidationFailed"; invalidities: ReadonlyArray<DomainBlockInvalidity> }>
  | Readonly<{ kind: "OwnDomain" }>
  /** The rule already covering the domain is on it, or is not weaker. */
  | Readonly<{ kind: "ExistingDomainBlock"; existing: DomainBlockRow }>
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
  const applied = await blockEffects(env, block.value);
  return applied.map(() => block.value);
};

/**
 * What making a block does to what is stored: the media of `reject_media`
 * cleared, the actors at or under the domain limited as the block says (in
 * queued pages, `startDomainBlockLimits`), the follows of a suspension
 * severed. Each finds nothing the second time, so a block can be applied
 * again, and applying a changed block lifts what its old severity set.
 */
const blockEffects = async (
  env: Env,
  block: DomainBlockRow,
): Promise<Result<void, RepositoryError>> => {
  const host = Hostname.ofAuthority(block.domain);
  if (block.reject_media !== 0) {
    await clearRemoteMediaForDomain(env.DB, host);
  }
  await startDomainBlockLimits(env, block.id);
  if (block.severity === "suspend") {
    return severAndNotify(env, {
      scope: { kind: "Domain", domain: host },
      type: "domain_block",
      targetName: block.domain,
    });
  }
  return ok(undefined);
};

/** Apply the instance domain block on `domain` as it stands now, as making it would; nothing when there is none. */
export const applyDomainBlockEffects = async (
  env: Env,
  domain: Hostname,
): Promise<Result<void, RepositoryError>> => {
  const block = await findDomainBlockByDomain(env.DB, domain);
  if (block.isErr()) {
    return err(block.error);
  }
  return block.value ? blockEffects(env, block.value) : ok(undefined);
};

const policyOf = (row: DomainBlockRow): DomainBlockPolicy => ({
  severity: row.severity,
  rejectMedia: row.reject_media !== 0,
  rejectReports: row.reject_reports !== 0,
});

/**
 * Block a domain, never this server's own. As Mastodon's
 * `Api::V1::Admin::DomainBlocksController#create`, refused when the rule
 * already covering the domain (`DomainBlock.rule_for`) names it or is not
 * weaker than the new block (`stricter_than?`).
 */
export const createDomainBlock = async (
  env: Env,
  ownDomain: string,
  rawDomain: string,
  request: DomainBlockRequest,
): Promise<Result<DomainBlockRow | undefined, CreateDomainBlockError>> => {
  const domain = Hostname.fromInput(rawDomain);
  if (domain === ownDomain.toLowerCase()) {
    return err({ kind: "OwnDomain" });
  }
  if (domain !== undefined) {
    const existing = await findDomainBlockRule(env.DB, domain);
    if (existing.isErr()) {
      return err(existing.error);
    }
    if (
      existing.value &&
      (existing.value.domain === domain ||
        !DomainBlockPolicy.stricterThan(request, policyOf(existing.value)))
    ) {
      return err({ kind: "ExistingDomainBlock", existing: existing.value });
    }
  }
  const domainInvalidity: DomainBlockInvalidity | undefined =
    domain === undefined
      ? "DomainBlank"
      : Hostname.isValidDomain(domain)
        ? undefined
        : "DomainInvalid";
  if (request.severity === undefined || domain === undefined || domainInvalidity !== undefined) {
    const invalidities: DomainBlockInvalidity[] = [];
    if (request.severity === undefined) {
      invalidities.push("SeverityNotIncluded");
    }
    if (domainInvalidity !== undefined) {
      invalidities.push(domainInvalidity);
    }
    return err({ kind: "ValidationFailed", invalidities });
  }
  const created = await insertDomainBlock(env.DB, {
    ...request,
    domain,
    severity: request.severity,
  });
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

/**
 * Remove a domain block; `false` when there is none. What it limited is
 * lifted at once, as `UnblockDomainService`, and the rows it left go in
 * queued pages.
 */
export const removeDomainBlock = async (
  env: Env,
  id: string,
): Promise<Result<boolean, RepositoryError>> => {
  const removed = await deleteDomainBlock(env.DB, id);
  if (removed.isOk() && removed.value) {
    await startDomainBlockLimits(env, id);
  }
  return removed;
};
