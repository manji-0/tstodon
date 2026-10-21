import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { InstanceIdentity, LocalAccount } from "@tstodon/domain";
import {
  type AccountModeration,
  getAccountModeration,
  listAccountModerations,
  setAccountModeration,
} from "../../account-moderation-store";
import {
  approveAccount,
  disabledAccountIds,
  isAccountSensitized,
  mediaObjectKeysForAccount,
  pendingAccountIds,
  sensitizedAccountIds,
  setAccountDisabled,
  setAccountSensitized,
} from "../../account-flag-store";
import { deleteAccount, findAccountById } from "../../account-store";
import { listAdminAccounts } from "../../account-admin-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAdminLimit,
  queryCursor,
  readBody,
  requireAdmin,
} from "../../http";
import { mastodonAccountDocument } from "../../account-documents";
import { parseInstanceIdentity } from "../../runtime-config";
import { findReportById, listOpenReportIdsForTarget, setReportResolved } from "../../report-store";
import { isTruthy } from "../../form-values";

export const adminAccountRoutes = new Hono<{ Bindings: Env }>();

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
    origin: present("remote") ? "remote" : "local",
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
  account: LocalAccount,
  moderation: AccountModeration | null,
  sensitized: boolean,
  pending: boolean,
  disabled: boolean,
): Promise<Record<string, unknown>> => ({
  ...(await mastodonAccountDocument(env, identity, account)),
  email: account.accessEmail.unwrap(),
  ip: null,
  role: { id: "-1", name: "user", highlighted: false },
  approved: !pending,
  // `disable` blocks the login; it is separate from suspension.
  disabled,
  silenced: moderation === "Silenced",
  suspended: moderation === "Suspended",
  limited: moderation !== null,
  sensitized,
  invited_by_account_id: null,
  created_by_application_id: null,
  invite_request: null,
});

adminAccountRoutes.get("/api/v1/admin/accounts/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const document = await adminAccountFor(c.env, identity.value, c.req.param("id") ?? "");
  if (!document) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(document);
});

adminAccountRoutes.get("/api/v1/admin/accounts", async (c) => {
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
  const accounts = await listAdminAccounts(c.env.DB, {
    ...adminAccountFilters(c),
    cursor: queryCursor(c),
    limit,
    offset,
  });
  if (accounts.isErr()) {
    return jsonRepositoryError(c, accounts.error.message);
  }
  const moderations = await listAccountModerations(
    c.env.DB,
    accounts.value.map((account) => account.id),
  );
  if (moderations.isErr()) {
    return jsonRepositoryError(c, moderations.error.message);
  }
  const sensitized = await sensitizedAccountIds(
    c.env.DB,
    accounts.value.map((account) => account.id),
  );
  if (sensitized.isErr()) {
    return jsonRepositoryError(c, sensitized.error.message);
  }
  const pending = await pendingAccountIds(
    c.env.DB,
    accounts.value.map((account) => account.id),
  );
  if (pending.isErr()) {
    return jsonRepositoryError(c, pending.error.message);
  }
  const disabled = await disabledAccountIds(
    c.env.DB,
    accounts.value.map((account) => account.id),
  );
  if (disabled.isErr()) {
    return jsonRepositoryError(c, disabled.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  for (const account of accounts.value) {
    documents.push(
      await adminAccountDocument(
        c.env,
        identity.value,
        account,
        moderations.value.get(account.id) ?? null,
        sensitized.value.has(account.id),
        pending.value.has(account.id),
        disabled.value.has(account.id),
      ),
    );
  }
  return c.json(documents);
});

const setAccountModerationRoute = async (
  c: Context<{ Bindings: Env }>,
  moderation: AccountModeration | null,
): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const account = await findAccountById(c.env.DB, c.req.param("id") ?? "");
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const changed = await setAccountModeration(c.env.DB, account.value.id, moderation);
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  const sensitized = await isAccountSensitized(c.env.DB, account.value.id);
  const pending = await pendingAccountIds(c.env.DB, [account.value.id]);
  const disabled = await disabledAccountIds(c.env.DB, [account.value.id]);
  return c.json(
    await adminAccountDocument(
      c.env,
      identity.value,
      account.value,
      moderation,
      sensitized.isOk() ? sensitized.value : false,
      pending.isOk() ? pending.value.has(account.value.id) : false,
      disabled.isOk() ? disabled.value.has(account.value.id) : false,
    ),
  );
};

adminAccountRoutes.post("/api/v1/admin/accounts/:id/silence", (c) =>
  setAccountModerationRoute(c, "Silenced"),
);
adminAccountRoutes.post("/api/v1/admin/accounts/:id/unsilence", (c) =>
  setAccountModerationRoute(c, null),
);
adminAccountRoutes.post("/api/v1/admin/accounts/:id/suspend", (c) =>
  setAccountModerationRoute(c, "Suspended"),
);
adminAccountRoutes.post("/api/v1/admin/accounts/:id/unsuspend", (c) =>
  setAccountModerationRoute(c, null),
);
/**
 * `POST /:id/enable` restores a disabled login (Mastodon's `user.enable!`); it
 * does not lift a silence or a suspension — `/unsilence` and `/unsuspend` do.
 */
adminAccountRoutes.post("/api/v1/admin/accounts/:id/enable", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const account = await findAccountById(c.env.DB, c.req.param("id") ?? "");
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const enabled = await setAccountDisabled(c.env.DB, account.value.id, false);
  if (enabled.isErr()) {
    return jsonRepositoryError(c, enabled.error.message);
  }
  const moderation = await getAccountModeration(c.env.DB, account.value.id);
  const sensitized = await isAccountSensitized(c.env.DB, account.value.id);
  const pending = await pendingAccountIds(c.env.DB, [account.value.id]);
  return c.json(
    await adminAccountDocument(
      c.env,
      identity.value,
      account.value,
      moderation.isOk() ? moderation.value : null,
      sensitized.isOk() ? sensitized.value : false,
      pending.isOk() ? pending.value.has(account.value.id) : false,
      false,
    ),
  );
});

/** An `Admin::Account` for an id, with its moderation and flag state. */
export const adminAccountFor = async (
  env: Env,
  identity: InstanceIdentity,
  accountId: string,
): Promise<Record<string, unknown> | null> => {
  const account = await findAccountById(env.DB, accountId);
  if (account.isErr() || !account.value) {
    return null;
  }
  const moderation = await getAccountModeration(env.DB, accountId);
  const sensitized = await isAccountSensitized(env.DB, accountId);
  const pending = await pendingAccountIds(env.DB, [accountId]);
  const disabled = await disabledAccountIds(env.DB, [accountId]);
  return adminAccountDocument(
    env,
    identity,
    account.value,
    moderation.isOk() ? moderation.value : null,
    sensitized.isOk() ? sensitized.value : false,
    pending.isOk() && pending.value.has(accountId),
    disabled.isOk() && disabled.value.has(accountId),
  );
};

/** Mastodon's `Admin::Report` document. */

const setSensitized = async (
  c: Context<{ Bindings: Env }>,
  sensitized: boolean,
): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const account = await findAccountById(c.env.DB, c.req.param("id") ?? "");
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const changed = await setAccountSensitized(c.env.DB, account.value.id, sensitized);
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  const moderation = await getAccountModeration(c.env.DB, account.value.id);
  const pending = await pendingAccountIds(c.env.DB, [account.value.id]);
  const disabled = await disabledAccountIds(c.env.DB, [account.value.id]);
  return c.json(
    await adminAccountDocument(
      c.env,
      identity.value,
      account.value,
      moderation.isOk() ? moderation.value : null,
      sensitized,
      pending.isOk() ? pending.value.has(account.value.id) : false,
      disabled.isOk() ? disabled.value.has(account.value.id) : false,
    ),
  );
};

/**
 * Approve or reject the local account waiting for approval. Rejecting purges
 * the account (Mastodon's `DeleteAccountService`), so the document is built
 * first and answered with `approved: false`.
 */
const approveOrReject = async (c: Context<{ Bindings: Env }>, approve: boolean) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const account = await findAccountById(c.env.DB, id);
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const moderation = await getAccountModeration(c.env.DB, id);
  const sensitized = await isAccountSensitized(c.env.DB, id);
  const disabled = await disabledAccountIds(c.env.DB, [id]);
  const loginDisabled = disabled.isOk() && disabled.value.has(id);
  if (approve) {
    const approved = await approveAccount(c.env.DB, id);
    if (approved.isErr()) {
      return jsonRepositoryError(c, approved.error.message);
    }
    return c.json(
      await adminAccountDocument(
        c.env,
        identity.value,
        account.value,
        moderation.isOk() ? moderation.value : null,
        sensitized.isOk() ? sensitized.value : false,
        false,
        loginDisabled,
      ),
    );
  }
  const document = await adminAccountDocument(
    c.env,
    identity.value,
    account.value,
    moderation.isOk() ? moderation.value : null,
    sensitized.isOk() ? sensitized.value : false,
    true,
    loginDisabled,
  );
  const objects = await mediaObjectKeysForAccount(c.env.DB, id);
  if (objects.isErr()) {
    return jsonRepositoryError(c, objects.error.message);
  }
  for (const objectKey of objects.value) {
    await c.env.MEDIA.delete(objectKey);
  }
  const purged = await deleteAccount(c.env.DB, id);
  if (purged.isErr()) {
    return jsonRepositoryError(c, purged.error.message);
  }
  return c.json(document);
};

const AccountActionBodySchema = z.object({
  type: z.string().optional(),
  report_id: z.union([z.string(), z.number()]).optional(),
});

/**
 * `POST /api/v1/admin/accounts/:id/action` — the moderation action Mastodon
 * documents (`none`, `sensitive`, `disable`, `silence`, `suspend`). The report
 * resolution and warning text around it are not part of this instance yet.
 */
adminAccountRoutes.post("/api/v1/admin/accounts/:id/action", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readBody(c, AccountActionBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const type = (body.value.type ?? "").trim().toLowerCase();
  if (!["none", "sensitive", "disable", "silence", "suspend"].includes(type)) {
    return c.json({ error: "Record invalid", kind: "ValidationError" }, 422);
  }
  const account = await findAccountById(c.env.DB, c.req.param("id") ?? "");
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const id = account.value.id;
  if (type === "sensitive") {
    const changed = await setAccountSensitized(c.env.DB, id, true);
    if (changed.isErr()) {
      return jsonRepositoryError(c, changed.error.message);
    }
  }
  if (type === "disable") {
    const changed = await setAccountDisabled(c.env.DB, id, true);
    if (changed.isErr()) {
      return jsonRepositoryError(c, changed.error.message);
    }
  }
  if (type === "silence" || type === "suspend") {
    const changed = await setAccountModeration(
      c.env.DB,
      id,
      type === "silence" ? "Silenced" : "Suspended",
    );
    if (changed.isErr()) {
      return jsonRepositoryError(c, changed.error.message);
    }
  }
  // Mastodon resolves the report that prompted the action, or every open
  // report against the account when none is named.
  const requestedReport = body.value.report_id;
  const reportId = requestedReport === undefined ? "" : String(requestedReport).trim();
  const reporterAccountId = admin.value.account.id;
  if (reportId.length > 0) {
    const report = await findReportById(c.env.DB, reportId);
    if (report.isErr()) {
      return jsonRepositoryError(c, report.error.message);
    }
    if (!report.value) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    const resolved = await setReportResolved(c.env.DB, reportId, reporterAccountId);
    if (resolved.isErr()) {
      return jsonRepositoryError(c, resolved.error.message);
    }
  } else {
    const open = await listOpenReportIdsForTarget(c.env.DB, id);
    if (open.isErr()) {
      return jsonRepositoryError(c, open.error.message);
    }
    for (const openId of open.value) {
      const resolved = await setReportResolved(c.env.DB, openId, reporterAccountId);
      if (resolved.isErr()) {
        return jsonRepositoryError(c, resolved.error.message);
      }
    }
  }
  return c.json({});
});

adminAccountRoutes.post("/api/v1/admin/accounts/:id/approve", (c) => approveOrReject(c, true));
adminAccountRoutes.post("/api/v1/admin/accounts/:id/reject", (c) => approveOrReject(c, false));

adminAccountRoutes.post("/api/v1/admin/accounts/:id/sensitize", (c) => setSensitized(c, true));
adminAccountRoutes.post("/api/v1/admin/accounts/:id/unsensitize", (c) => setSensitized(c, false));

adminAccountRoutes.delete("/api/v1/admin/accounts/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const account = await findAccountById(c.env.DB, id);
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  // Drop the account's bucket objects first; rows cascade from `accounts`.
  const objects = await mediaObjectKeysForAccount(c.env.DB, id);
  if (objects.isErr()) {
    return jsonRepositoryError(c, objects.error.message);
  }
  for (const objectKey of objects.value) {
    await c.env.MEDIA.delete(objectKey);
  }
  const purged = await deleteAccount(c.env.DB, id);
  if (purged.isErr()) {
    return jsonRepositoryError(c, purged.error.message);
  }
  if (!purged.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
});

/** The review fields Mastodon's Admin::Tag serializer adds to a tag. */
