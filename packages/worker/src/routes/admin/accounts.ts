import type { Context } from "hono";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import {
  type InstanceIdentity,
  RemoteActorModeration,
  type RemoteActorModerationAction,
  type RemoteActorModerationValue,
  type RemoteActorValue,
} from "@tstodon/domain";
import { setAccountModeration } from "../../account-moderation-store";
import { approveAccount, setAccountDisabled, setAccountSensitized } from "../../account-flag-store";
import { findAccountById } from "../../account-store";
import { listAdminAccounts, listAdminRemoteActorUris } from "../../account-admin-store";
import {
  AccountActionTypeSchema,
  type AdminAccountState,
  adminAccountStates,
  findAdminAccount,
  findAdminRemoteActor,
  moderateRemoteActor,
  purgeAccount,
  takeAccountAction,
} from "../../admin-actions";
import { listRemoteActorModerations } from "../../remote-actor-moderation-store";
import { RemoteAccountId } from "../../remote-account-id";
import type { RepositoryError } from "../../d1";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAdminLimit,
  queryCursor,
  readBody,
  requireAdmin,
} from "../../http";
import { mastodonAccountDocument, mastodonRemoteAccount } from "../../account-documents";
import { findRemoteActorsByUris } from "../../remote-actor-store";
import type { ReportParty } from "../../report-store";
import { parseInstanceIdentity } from "../../runtime-config";
import { isTruthy } from "../../form-values";

const adminAccountFilters = (
  c: Context<{ Bindings: Env }>,
): Readonly<{
  origin: "local" | "remote";
  status: "active" | "pending" | "disabled" | "silenced" | "suspended" | "sensitized";
  username?: string | undefined;
  displayName?: string | undefined;
  email?: string | undefined;
  byDomain?: string | undefined;
  ip?: string | undefined;
  staff?: boolean | undefined;
}> => {
  const present = (key: string): boolean => isTruthy(c.req.query(key));
  let status: "active" | "pending" | "disabled" | "silenced" | "suspended" = "active";
  for (const candidate of ["active", "pending", "disabled", "silenced", "suspended"] as const) {
    if (present(candidate)) {
      status = candidate;
    }
  }
  const trimmed = (key: string): string | undefined => {
    const value = c.req.query(key)?.trim() ?? "";
    return value.length > 0 ? value : undefined;
  };
  return {
    origin: present("remote") || c.req.query("origin") === "remote" ? "remote" : "local",
    status: present("sensitized") ? "sensitized" : status,
    username: trimmed("username"),
    displayName: trimmed("display_name"),
    email: trimmed("email"),
    byDomain: trimmed("by_domain"),
    ip: trimmed("ip"),
    staff: present("staff"),
  };
};

const adminAccountDocument = async (
  env: Env,
  identity: InstanceIdentity,
  state: AdminAccountState,
): Promise<Record<string, unknown>> => ({
  ...(await mastodonAccountDocument(env, identity, state.account)),
  email: state.account.accessEmail.reveal(),
  ip: null,
  role: { id: "-1", name: "user", highlighted: false },
  approved: !state.pending,
  // `disable` blocks the login; it is separate from suspension.
  disabled: state.disabled,
  silenced: state.moderation === "Silenced",
  suspended: state.moderation === "Suspended",
  limited: state.moderation !== null,
  sensitized: state.sensitized,
  invited_by_account_id: null,
  created_by_application_id: null,
  invite_request: null,
});

/** An `Admin::Account` for a remote actor: it has no login, email, or IP here. */
const adminRemoteDocument = (
  account: Record<string, unknown>,
  domain: string,
  moderation: RemoteActorModerationValue,
): Record<string, unknown> => ({
  ...account,
  domain,
  email: null,
  ip: null,
  role: { id: "-1", name: "user", highlighted: false },
  approved: true,
  disabled: false,
  silenced: moderation.standing.kind === "Silenced",
  suspended: moderation.standing.kind === "Suspended",
  limited: moderation.standing.kind !== "InGoodStanding",
  sensitized: moderation.sensitized,
  invited_by_account_id: null,
  created_by_application_id: null,
  invite_request: null,
});

const remoteActorDocument = (
  identity: InstanceIdentity,
  actor: RemoteActorValue,
  moderation: RemoteActorModerationValue,
): Record<string, unknown> =>
  adminRemoteDocument(mastodonRemoteAccount(identity, actor), actor.domain, moderation);

/**
 * What a report remembers of a remote actor that was purged from the cache:
 * its handle, with the rest of the account blank.
 */
const purgedRemoteDocument = (
  identity: InstanceIdentity,
  actorUri: string,
  acct: string,
): Record<string, unknown> => {
  const separator = acct.lastIndexOf("@");
  const username = separator > 0 ? acct.slice(0, separator) : acct;
  const domain = separator > 0 ? acct.slice(separator + 1) : "";
  return adminRemoteDocument(
    {
      id: RemoteAccountId.encode(actorUri),
      username,
      acct,
      display_name: "",
      locked: false,
      bot: false,
      discoverable: false,
      group: false,
      created_at: new Date(0).toISOString(),
      note: "",
      url: actorUri,
      uri: actorUri,
      avatar: identity.thumbnailUrl,
      avatar_static: identity.thumbnailUrl,
      header: identity.thumbnailUrl,
      header_static: identity.thumbnailUrl,
      followers_count: 0,
      following_count: 0,
      statuses_count: 0,
      last_status_at: null,
      emojis: [],
      fields: [],
    },
    domain,
    RemoteActorModeration.inGoodStanding,
  );
};

/** An `Admin::Account` for an id, with its moderation and flag state. */
export const adminAccountFor = async (
  env: Env,
  identity: InstanceIdentity,
  accountId: string,
): Promise<Record<string, unknown> | null> => {
  const actorUri = RemoteAccountId.decode(accountId);
  if (actorUri.isOk()) {
    const state = await findAdminRemoteActor(env.DB, actorUri.value);
    return state.isOk() && state.value
      ? remoteActorDocument(identity, state.value.actor, state.value.moderation)
      : null;
  }
  const state = await findAdminAccount(env.DB, accountId);
  return state.isOk() && state.value ? adminAccountDocument(env, identity, state.value) : null;
};

/**
 * A report's reporter or target as an `Admin::Account`. A remote actor has no
 * login or email. One purged from the cache is shown from the handle the
 * report kept (`acct`); `null` when the report kept none.
 */
export const adminPartyFor = async (
  env: Env,
  identity: InstanceIdentity,
  party: ReportParty,
  acct: string | null,
): Promise<Record<string, unknown> | null> => {
  if (party.kind === "Local") {
    return adminAccountFor(env, identity, party.accountId);
  }
  const state = await findAdminRemoteActor(env.DB, party.actorUri);
  if (state.isOk() && state.value) {
    return remoteActorDocument(identity, state.value.actor, state.value.moderation);
  }
  return acct === null ? null : purgedRemoteDocument(identity, party.actorUri, acct);
};

const notFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

export const getV1AdminAccountsById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const document = await adminAccountFor(c.env, identity.value, c.req.param("id") ?? "");
  return document ? c.json(document) : notFound(c);
};

/**
 * `origin=remote`: the cached remote actors, by username. Their ids are not
 * ordered by arrival, so this list pages by `offset`, not by id cursor.
 */
const remoteAdminAccounts = async (
  env: Env,
  identity: InstanceIdentity,
  filters: Parameters<typeof listAdminRemoteActorUris>[1],
): Promise<Result<Record<string, unknown>[], RepositoryError>> => {
  const uris = await listAdminRemoteActorUris(env.DB, filters);
  if (uris.isErr()) {
    return err(uris.error);
  }
  const [actors, moderations] = await Promise.all([
    findRemoteActorsByUris(env.DB, uris.value),
    listRemoteActorModerations(env.DB, uris.value),
  ]);
  if (actors.isErr()) {
    return err(actors.error);
  }
  if (moderations.isErr()) {
    return err(moderations.error);
  }
  return ok(
    uris.value.flatMap((uri) => {
      const actor = actors.value.get(uri);
      return actor
        ? [
            remoteActorDocument(
              identity,
              actor,
              moderations.value.get(uri) ?? RemoteActorModeration.inGoodStanding,
            ),
          ]
        : [];
    }),
  );
};

export const getV1AdminAccounts = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const limit = queryAdminLimit(c.req.query("limit"));
  const offset = Math.max(Number.parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const filters = adminAccountFilters(c);
  if (filters.origin === "remote") {
    const remote = await remoteAdminAccounts(c.env, identity.value, { ...filters, limit, offset });
    return remote.isErr() ? jsonRepositoryError(c, remote.error.message) : c.json(remote.value);
  }
  const accounts = await listAdminAccounts(c.env.DB, {
    ...filters,
    cursor: queryCursor(c),
    limit,
    offset,
  });
  if (accounts.isErr()) {
    return jsonRepositoryError(c, accounts.error.message);
  }
  const states = await adminAccountStates(c.env.DB, accounts.value);
  if (states.isErr()) {
    return jsonRepositoryError(c, states.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  for (const state of states.value) {
    documents.push(await adminAccountDocument(c.env, identity.value, state));
  }
  return c.json(documents);
};

/**
 * Change one account, then answer its `Admin::Account` as it now is. A remote
 * actor (`r_…` id) takes the change only when `remoteAction` names its
 * counterpart; the others (login, approval) do not exist for it.
 */
const changeAccount = async (
  c: Context<{ Bindings: Env }>,
  change: (db: D1Database, accountId: string) => Promise<Result<void, RepositoryError>>,
  remoteAction?: RemoteActorModerationAction,
): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const actorUri = RemoteAccountId.decode(c.req.param("id") ?? "");
  if (actorUri.isOk() && remoteAction !== undefined) {
    const known = await findAdminRemoteActor(c.env.DB, actorUri.value);
    if (known.isErr()) {
      return jsonRepositoryError(c, known.error.message);
    }
    if (!known.value) {
      return notFound(c);
    }
    const moderated = await moderateRemoteActor(c.env, actorUri.value, remoteAction);
    if (moderated.isErr()) {
      return jsonRepositoryError(c, moderated.error.message);
    }
    const document = await adminAccountFor(c.env, identity.value, c.req.param("id") ?? "");
    return document ? c.json(document) : notFound(c);
  }
  const account = await findAccountById(c.env.DB, c.req.param("id") ?? "");
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return notFound(c);
  }
  const changed = await change(c.env.DB, account.value.id);
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  const document = await adminAccountFor(c.env, identity.value, account.value.id);
  return document ? c.json(document) : notFound(c);
};

export const postV1AdminAccountsByIdSilence = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/silence">,
) => changeAccount(c, (db, id) => setAccountModeration(db, id, "Silenced"), "silence");
export const postV1AdminAccountsByIdUnsilence = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/unsilence">,
) => changeAccount(c, (db, id) => setAccountModeration(db, id, null), "unsilence");
export const postV1AdminAccountsByIdSuspend = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/suspend">,
) => changeAccount(c, (db, id) => setAccountModeration(db, id, "Suspended"), "suspend");
export const postV1AdminAccountsByIdUnsuspend = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/unsuspend">,
) => changeAccount(c, (db, id) => setAccountModeration(db, id, null), "unsuspend");
/**
 * `POST /:id/enable` restores a disabled login (Mastodon's `user.enable!`); it
 * does not lift a silence or a suspension: `/unsilence` and `/unsuspend` do.
 */
export const postV1AdminAccountsByIdEnable = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/enable">,
) => changeAccount(c, (db, id) => setAccountDisabled(db, id, false));
export const postV1AdminAccountsByIdSensitize = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/sensitize">,
) => changeAccount(c, (db, id) => setAccountSensitized(db, id, true), "sensitize");
export const postV1AdminAccountsByIdUnsensitize = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/unsensitize">,
) => changeAccount(c, (db, id) => setAccountSensitized(db, id, false), "unsensitize");
export const postV1AdminAccountsByIdApprove = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/approve">,
) => changeAccount(c, approveAccount);

/**
 * Reject the local account waiting for approval. Rejecting purges the
 * account, so the document is built first and answered with `approved: false`.
 */
export const postV1AdminAccountsByIdReject = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/reject">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const state = await findAdminAccount(c.env.DB, c.req.param("id") ?? "");
  if (state.isErr()) {
    return jsonRepositoryError(c, state.error.message);
  }
  if (!state.value) {
    return notFound(c);
  }
  const document = await adminAccountDocument(c.env, identity.value, {
    ...state.value,
    pending: true,
  });
  const purged = await purgeAccount(c.env, state.value.account.id);
  return purged.isErr() ? jsonRepositoryError(c, purged.error.message) : c.json(document);
};

const AccountActionBodySchema = z.object({
  type: z.string().optional(),
  report_id: z.union([z.string(), z.number()]).optional(),
});

const parseActionType = schemaResult(AccountActionTypeSchema);

/**
 * `POST /api/v1/admin/accounts/:id/action`: the moderation action Mastodon
 * documents (`none`, `sensitive`, `disable`, `silence`, `suspend`). The
 * warning text around it is not part of this instance yet.
 */
export const postV1AdminAccountsByIdAction = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/action">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readBody(c, AccountActionBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const type = parseActionType((body.value.type ?? "").trim().toLowerCase());
  if (type.isErr()) {
    return c.json({ error: "Record invalid", kind: "ValidationError" }, 422);
  }
  const reportId = String(body.value.report_id ?? "").trim();
  const taken = await takeAccountAction(c.env, {
    accountId: c.req.param("id") ?? "",
    type: type.value,
    reportId: reportId.length > 0 ? reportId : undefined,
    moderatorId: admin.value.account.id,
  });
  if (taken.isOk()) {
    return c.json({});
  }
  switch (taken.error.kind) {
    case "AccountNotFound":
    case "ReportNotFound":
      return notFound(c);
    case "NotApplicable":
      return c.json({ error: "Record invalid", kind: "ValidationError" }, 422);
    case "RepositoryError":
      return jsonRepositoryError(c, taken.error.message);
  }
};

export const deleteV1AdminAccountsById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const purged = await purgeAccount(c.env, c.req.param("id") ?? "");
  if (purged.isErr()) {
    return jsonRepositoryError(c, purged.error.message);
  }
  return purged.value ? c.json({}) : notFound(c);
};
