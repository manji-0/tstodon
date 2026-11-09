import type { Context } from "hono";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { ApiAccountJSON, ApiAdminAccountJSON } from "@tstodon/api";
import {
  AccountActionType,
  FediRole,
  type InstanceIdentity,
  IpRange,
  LocalAccountModeration,
  type LocalAccountModerationAction,
  RemoteActorModeration,
  type RemoteActorModerationValue,
  type RemoteActorValue,
} from "@tstodon/domain";
import { findAccountById } from "../../account-store";
import {
  type AdminAccountFilters,
  listAdminAccountIds,
  listAdminAccounts,
  listAdminRemoteActorUris,
} from "../../account-admin-store";
import { type AccountIp, accountIpsByAccountIds, allAccountIps } from "../../account-activity";
import {
  type AdminAccountState,
  adminAccountStates,
  findAdminAccount,
  findAdminRemoteActor,
  moderateLocalAccount,
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
  setPaginationLinks,
} from "../../http";
import { mastodonAccountDocument, mastodonRemoteAccount } from "../../account-documents";
import { findRemoteActorsByUris } from "../../remote-actor-store";
import type { ReportParty } from "../../report-store";
import { parseInstanceIdentity } from "../../runtime-config";
import { isTruthy } from "../../form-values";

type RequestedFilters = Omit<AdminAccountFilters, "cursor" | "limit" | "offset" | "accountIds">;

const trimmedQuery = (c: Context<{ Bindings: Env }>, key: string): string | undefined => {
  const value = c.req.query(key)?.trim() ?? "";
  return value.length > 0 ? value : undefined;
};

/** v1's filters: flags (`local`, `remote`, `active`, ...), local and active by default. */
const adminAccountFilters = (c: Context<{ Bindings: Env }>): RequestedFilters => {
  const present = (key: string): boolean => isTruthy(c.req.query(key));
  let status: "active" | "pending" | "disabled" | "silenced" | "suspended" = "active";
  for (const candidate of ["active", "pending", "disabled", "silenced", "suspended"] as const) {
    if (present(candidate)) {
      status = candidate;
    }
  }
  return {
    origin: present("remote") || c.req.query("origin") === "remote" ? "remote" : "local",
    status: present("sensitized") ? "sensitized" : status,
    username: trimmedQuery(c, "username"),
    displayName: trimmedQuery(c, "display_name"),
    email: trimmedQuery(c, "email"),
    byDomain: trimmedQuery(c, "by_domain"),
    ip: trimmedQuery(c, "ip"),
    staff: present("staff"),
  };
};

const V2_STATUSES = [
  "active",
  "pending",
  "disabled",
  "silenced",
  "suspended",
  "sensitized",
] as const;

const isV2Status = (value: string): value is (typeof V2_STATUSES)[number] =>
  V2_STATUSES.some((status) => status === value);

/**
 * v2's filters (`Api::V2::Admin::AccountsController`): `origin`, `status`,
 * `permissions=staff`, `role_ids[]`, `invited_by`, `username`,
 * `display_name`, `by_domain`, `email`, `ip`. No `status` lists every
 * status. No `origin` lists local accounts: remote actors are cached under
 * ids that do not page with local ones, so they need `origin=remote`.
 */
const v2AccountFilters = (c: Context<{ Bindings: Env }>): RequestedFilters | "invalid" => {
  const origin = trimmedQuery(c, "origin") ?? "local";
  const status = trimmedQuery(c, "status");
  const permissions = trimmedQuery(c, "permissions");
  if (
    (origin !== "local" && origin !== "remote") ||
    (status !== undefined && !isV2Status(status)) ||
    (permissions !== undefined && permissions !== "staff")
  ) {
    return "invalid";
  }
  const roleIds = [...(c.req.queries("role_ids[]") ?? []), ...(c.req.queries("role_ids") ?? [])]
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return {
    origin,
    status: status ?? "all",
    username: trimmedQuery(c, "username"),
    displayName: trimmedQuery(c, "display_name"),
    email: trimmedQuery(c, "email"),
    byDomain: trimmedQuery(c, "by_domain"),
    ip: trimmedQuery(c, "ip"),
    staff: permissions === "staff",
    roleIds: roleIds.length > 0 ? roleIds : undefined,
    invitedBy: trimmedQuery(c, "invited_by"),
  };
};

/** A remote actor holds no role here. */
const USER_ROLE = FediRole.toMastodon(FediRole.User);

/** What a local account's document reads besides its state: its role and addresses. */
type LocalAccountExtras = Readonly<{ admin: boolean; ips: ReadonlyArray<AccountIp> }>;

const NO_EXTRAS: LocalAccountExtras = { admin: false, ips: [] };

/** Each account's role and recorded addresses. */
const localAccountExtras = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, LocalAccountExtras>> => {
  const [admins, ips] = await Promise.all([
    listAdminAccountIds(db),
    accountIpsByAccountIds(db, accountIds),
  ]);
  const adminIds = new Set(admins.unwrapOr([]));
  const byAccount = ips.unwrapOr(new Map<string, ReadonlyArray<AccountIp>>());
  return new Map(
    accountIds.map((id) => [id, { admin: adminIds.has(id), ips: byAccount.get(id) ?? [] }]),
  );
};

const adminAccountDocument = async (
  env: Env,
  identity: InstanceIdentity,
  state: AdminAccountState,
  extras: LocalAccountExtras = NO_EXTRAS,
): Promise<ApiAdminAccountJSON> => {
  const account = await mastodonAccountDocument(env, identity, state.account);
  return {
    id: account.id,
    username: account.username,
    domain: null,
    created_at: account.created_at,
    email: state.account.accessEmail.reveal(),
    // The address last used, then each recorded one (Mastodon's `user_ips`).
    ip: extras.ips[0]?.ip ?? null,
    ips: extras.ips.map((entry) => ({ ip: entry.ip, used_at: entry.usedAt })),
    locale: null,
    invite_request: null,
    role: { ...FediRole.toMastodon(extras.admin ? FediRole.Admin : FediRole.User) },
    // Access verified the address before the account existed.
    confirmed: true,
    approved: state.moderation.approval.kind === "Approved",
    // `disable` blocks the login; it is separate from suspension.
    disabled: state.moderation.login.kind === "Disabled",
    silenced: state.moderation.standing.kind === "Silenced",
    suspended: state.moderation.standing.kind === "Suspended",
    limited: state.moderation.standing.kind !== "InGoodStanding",
    sensitized: state.moderation.sensitized,
    account,
  };
};

/** An `Admin::Account` for a remote actor: it has no login, email, or IP here. */
const adminRemoteDocument = (
  account: ApiAccountJSON,
  domain: string,
  moderation: RemoteActorModerationValue,
): ApiAdminAccountJSON => ({
  id: account.id,
  username: account.username,
  domain,
  created_at: account.created_at,
  email: null,
  ip: null,
  ips: [],
  locale: null,
  invite_request: null,
  role: { ...USER_ROLE },
  // No login here to confirm.
  confirmed: false,
  approved: true,
  disabled: false,
  silenced: moderation.standing.kind === "Silenced",
  suspended: moderation.standing.kind === "Suspended",
  limited: moderation.standing.kind !== "InGoodStanding",
  sensitized: moderation.sensitized,
  account,
});

const remoteActorDocument = (
  identity: InstanceIdentity,
  actor: RemoteActorValue,
  moderation: RemoteActorModerationValue,
): ApiAdminAccountJSON =>
  adminRemoteDocument(mastodonRemoteAccount(identity, actor), actor.domain, moderation);

/**
 * What a report remembers of a remote actor that was purged from the cache:
 * its handle, with the rest of the account blank.
 */
const purgedRemoteDocument = (
  identity: InstanceIdentity,
  actorUri: string,
  acct: string,
): ApiAdminAccountJSON => {
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
      indexable: false,
      group: false,
      hide_collections: null,
      show_media: true,
      show_media_replies: true,
      show_featured: true,
      feature_approval: { automatic: [], manual: [], current_user: "denied" },
      created_at: new Date(0).toISOString(),
      note: "",
      url: actorUri,
      uri: actorUri,
      avatar: identity.thumbnailUrl,
      avatar_static: identity.thumbnailUrl,
      avatar_description: "",
      header: identity.thumbnailUrl,
      header_static: identity.thumbnailUrl,
      header_description: "",
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
): Promise<ApiAdminAccountJSON | null> => {
  const actorUri = RemoteAccountId.decode(accountId);
  if (actorUri.isOk()) {
    const state = await findAdminRemoteActor(env.DB, actorUri.value);
    return state.isOk() && state.value
      ? remoteActorDocument(identity, state.value.actor, state.value.moderation)
      : null;
  }
  const state = await findAdminAccount(env.DB, accountId);
  if (state.isErr() || !state.value) {
    return null;
  }
  const extras = await localAccountExtras(env.DB, [state.value.account.id]);
  return adminAccountDocument(env, identity, state.value, extras.get(state.value.account.id));
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
): Promise<ApiAdminAccountJSON | null> => {
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
): Promise<Result<ApiAdminAccountJSON[], RepositoryError>> => {
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

/**
 * The `ip` filter: the local accounts that used an address in the range (an
 * address or CIDR). `undefined` when no filter is asked; a range that does
 * not parse matches no one.
 */
const accountIdsByIp = async (
  db: D1Database,
  ip: string | undefined,
): Promise<Result<ReadonlyArray<string> | undefined, RepositoryError>> => {
  if (ip === undefined) {
    return ok(undefined);
  }
  const range = IpRange.parse(ip);
  if (range.isErr()) {
    return ok([]);
  }
  const pairs = await allAccountIps(db);
  return pairs.map((list) => [
    ...new Set(
      list.filter((pair) => IpRange.contains(range.value, pair.ip)).map((pair) => pair.accountId),
    ),
  ]);
};

/** The admin account list both versions answer, with Mastodon's `Link` header. */
const adminAccountsResponse = async (
  c: Context<{ Bindings: Env }>,
  filters: RequestedFilters,
): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const limit = queryAdminLimit(c.req.query("limit"));
  const offset = Math.max(Number.parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  if (filters.origin === "remote") {
    const remote = await remoteAdminAccounts(c.env, identity.value, { ...filters, limit, offset });
    return remote.isErr() ? jsonRepositoryError(c, remote.error.message) : c.json(remote.value);
  }
  const accountIds = await accountIdsByIp(c.env.DB, filters.ip);
  if (accountIds.isErr()) {
    return jsonRepositoryError(c, accountIds.error.message);
  }
  const accounts = await listAdminAccounts(c.env.DB, {
    ...filters,
    ip: undefined,
    accountIds: accountIds.value,
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
  const extras = await localAccountExtras(
    c.env.DB,
    states.value.map((state) => state.account.id),
  );
  const documents: ApiAdminAccountJSON[] = [];
  for (const state of states.value) {
    documents.push(
      await adminAccountDocument(c.env, identity.value, state, extras.get(state.account.id)),
    );
  }
  setPaginationLinks(
    c,
    documents.map((document) => document.id),
    limit,
  );
  return c.json(documents);
};

export const getV1AdminAccounts = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  return adminAccountsResponse(c, adminAccountFilters(c));
};

/** `GET /api/v2/admin/accounts`: v1's list with Mastodon's v2 filters. */
export const getV2AdminAccounts = async (
  c: Context<{ Bindings: Env }, "/api/v2/admin/accounts">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const filters = v2AccountFilters(c);
  if (filters === "invalid") {
    return c.json({ error: "Validation failed: invalid filter", kind: "ValidationError" }, 422);
  }
  return adminAccountsResponse(c, filters);
};

/**
 * Change one account, then answer its `Admin::Account` as it now is. A remote
 * actor (`r_…` id) takes the change only when the action has a remote
 * counterpart; the others (login, approval) do not exist for it.
 */
const changeAccount = async (
  c: Context<{ Bindings: Env }>,
  action: LocalAccountModerationAction,
): Promise<Response> => {
  const remoteAction = LocalAccountModeration.remoteCounterpart(action);
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
  const changed = await moderateLocalAccount(c.env.DB, account.value.id, action);
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  const document = await adminAccountFor(c.env, identity.value, account.value.id);
  return document ? c.json(document) : notFound(c);
};

export const postV1AdminAccountsByIdSilence = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/silence">,
) => changeAccount(c, "silence");
export const postV1AdminAccountsByIdUnsilence = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/unsilence">,
) => changeAccount(c, "unsilence");
export const postV1AdminAccountsByIdSuspend = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/suspend">,
) => changeAccount(c, "suspend");
export const postV1AdminAccountsByIdUnsuspend = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/unsuspend">,
) => changeAccount(c, "unsuspend");
/**
 * `POST /:id/enable` restores a disabled login (Mastodon's `user.enable!`); it
 * does not lift a silence or a suspension: `/unsilence` and `/unsuspend` do.
 */
export const postV1AdminAccountsByIdEnable = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/enable">,
) => changeAccount(c, "enable");
export const postV1AdminAccountsByIdSensitize = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/sensitize">,
) => changeAccount(c, "sensitize");
export const postV1AdminAccountsByIdUnsensitize = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/unsensitize">,
) => changeAccount(c, "unsensitize");
export const postV1AdminAccountsByIdApprove = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/approve">,
) => changeAccount(c, "approve");

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
    moderation: { ...state.value.moderation, approval: { kind: "Pending" } },
  });
  const purged = await purgeAccount(c.env, state.value.account.id);
  return purged.isErr() ? jsonRepositoryError(c, purged.error.message) : c.json(document);
};

const AccountActionBodySchema = z.object({
  type: z.string().optional(),
  report_id: z.union([z.string(), z.number()]).optional(),
});

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
  const type = AccountActionType.parse((body.value.type ?? "").trim().toLowerCase());
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
