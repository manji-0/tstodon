import { z } from "zod";
import { type LocalAccount } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { jsonStringArray, okValues, parseRows, type RepositoryError, runD1 } from "./d1";
import { queryTyped } from "./typed-sql";
import { listAdminAccountIds as listAdminAccountIdsSql } from "./generated/prisma/sql";
import { accountFromRow, parseAccountRow, STATUS_SQL } from "./account-store";

const ActorUriRow = z.object({ actor_uri: z.string() });
const IdRow = z.object({ id: z.string().nullable() });

/**
 * Mastodon's admin account filters. `origin`/`status` are the translated form
 * (`local`/`active` by default on v1; v2 may ask for `all` statuses); the
 * text filters are case-insensitive substrings. `accountIds` narrows the
 * list to these ids (the `ip` filter, matched by the caller against the
 * recorded addresses). `staff` and `roleIds` read the sign-in user's role
 * (`admin` or `user`). States this instance cannot hold (`byDomain` on
 * local accounts, `invitedBy`: there are no invites) match nothing rather
 * than being ignored.
 */
export type AdminAccountFilters = Readonly<{
  origin: "local" | "remote";
  status: "all" | "active" | "pending" | "disabled" | "silenced" | "suspended" | "sensitized";
  username?: string | undefined;
  displayName?: string | undefined;
  email?: string | undefined;
  byDomain?: string | undefined;
  ip?: string | undefined;
  staff?: boolean | undefined;
  roleIds?: ReadonlyArray<string> | undefined;
  invitedBy?: string | undefined;
  accountIds?: ReadonlyArray<string> | undefined;
  cursor?: IdCursor | undefined;
  limit: number;
  offset: number;
}>;

/** Local accounts whose sign-in user holds the admin role (roles are comma-separated). */
const ADMIN_IDS_SQL = `SELECT a.id FROM accounts a JOIN "user" u ON u.id = a.auth_user_id
  WHERE (',' || REPLACE(u.role, ' ', '') || ',') LIKE '%,admin,%'`;

/**
 * `role_ids[]`: tstodon's roles are `admin` and `user` (`FediRole`'s ids).
 * Both, or none given, filter nothing; ids of neither match nothing.
 */
const roleIdsCondition = (roleIds: ReadonlyArray<string> | undefined): string | undefined => {
  if (roleIds === undefined || roleIds.length === 0) {
    return undefined;
  }
  const admin = roleIds.includes("admin");
  const user = roleIds.includes("user");
  if (admin && user) {
    return undefined;
  }
  if (admin) {
    return `id IN (${ADMIN_IDS_SQL})`;
  }
  return user ? `id NOT IN (${ADMIN_IDS_SQL})` : "0";
};

export const listAdminAccounts = async (
  db: D1Database,
  filters: AdminAccountFilters,
): Promise<Result<LocalAccount[], RepositoryError>> =>
  runD1(async () => {
    const conditions = [STATUS_SQL[filters.status]];
    const binds: Array<string | number> = [];
    if (filters.origin === "remote") {
      // Every account in this table is local.
      conditions.push("0");
    }
    if (filters.username) {
      conditions.push("username LIKE ?");
      binds.push(`%${filters.username}%`);
    }
    if (filters.displayName) {
      conditions.push("display_name LIKE ?");
      binds.push(`%${filters.displayName}%`);
    }
    if (filters.email) {
      conditions.push("access_email LIKE ?");
      binds.push(`${filters.email.toLowerCase()}%`);
    }
    if (filters.byDomain || filters.invitedBy) {
      // No domain (local only), no invites.
      conditions.push("0");
    }
    if (filters.accountIds !== undefined) {
      conditions.push("id IN (SELECT value FROM json_each(?))");
      binds.push(jsonStringArray(filters.accountIds));
    }
    if (filters.staff) {
      conditions.push(`id IN (${ADMIN_IDS_SQL})`);
    }
    const roleCondition = roleIdsCondition(filters.roleIds);
    if (roleCondition !== undefined) {
      conditions.push(roleCondition);
    }
    // Mastodon pages this list by account id; `offset` stays as an
    // undocumented fallback for callers that still use it.
    const { where, order, binds: cursorBinds } = idCursorFragment(filters.cursor);
    const pagination = filters.cursor === undefined ? "LIMIT ? OFFSET ?" : `LIMIT ?`;
    const { results } = await db
      .prepare(
        `SELECT id, username, access_email, display_name, locked, default_post_visibility, default_quote_policy,
                public_key_pem, private_key_jwk, created_at, COALESCE(bio_text, '') AS bio_text
         FROM accounts
         WHERE ${conditions.join(" AND ")} ${where}
         ${order}
         ${pagination}`,
      )
      .bind(
        ...binds,
        ...cursorBinds,
        filters.limit,
        ...(filters.cursor === undefined ? [filters.offset] : []),
      )
      .all();
    return okValues(
      (results ?? []).map((raw) => parseAccountRow(raw).andThen((row) => accountFromRow(row))),
    );
  });

/** Ids of the local accounts whose sign-in user holds the admin role. */
export const listAdminAccountIds = async (
  db: D1Database,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  runD1(async () =>
    (await queryTyped(db, listAdminAccountIdsSql(), IdRow)).flatMap((row) =>
      row.id ? [row.id] : [],
    ),
  );

/**
 * The remote actors an admin's `origin=remote` list shows, as actor URIs in
 * username order. A remote actor can be limited, suspended, or have its media
 * marked sensitive; it has no sign-up, login, email, or IP here, so
 * `pending`, `disabled`, `email`, `ip`, and `staff` match nothing.
 */
export const listAdminRemoteActorUris = async (
  db: D1Database,
  filters: Pick<
    AdminAccountFilters,
    | "status"
    | "username"
    | "displayName"
    | "email"
    | "byDomain"
    | "ip"
    | "staff"
    | "roleIds"
    | "invitedBy"
    | "limit"
    | "offset"
  >,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  runD1(async () => {
    const standing = (comparison: string): string =>
      `COALESCE((SELECT moderation FROM remote_actor_moderation m WHERE m.actor_uri = a.actor_uri), '') ${comparison}`;
    const statusCondition: Record<AdminAccountFilters["status"], string> = {
      all: "1",
      active: standing("<> 'Suspended'"),
      silenced: standing("= 'Silenced'"),
      suspended: standing("= 'Suspended'"),
      sensitized:
        "EXISTS (SELECT 1 FROM remote_actor_moderation m WHERE m.actor_uri = a.actor_uri AND m.sensitized <> 0)",
      pending: "0",
      disabled: "0",
    };
    const conditions = [statusCondition[filters.status]];
    const binds: Array<string | number> = [];
    if (filters.username) {
      conditions.push("a.username LIKE ?");
      binds.push(`%${filters.username}%`);
    }
    if (filters.displayName) {
      conditions.push("a.display_name LIKE ?");
      binds.push(`%${filters.displayName}%`);
    }
    if (filters.byDomain) {
      conditions.push("(lower(a.domain) = ? OR a.host = ?)");
      binds.push(filters.byDomain.toLowerCase(), filters.byDomain.toLowerCase());
    }
    // A remote actor has no email, recorded address, role, or inviter here.
    if (
      filters.email ||
      filters.ip ||
      filters.staff ||
      filters.invitedBy ||
      (filters.roleIds !== undefined && filters.roleIds.length > 0)
    ) {
      conditions.push("0");
    }
    const { results } = await db
      .prepare(
        `SELECT a.actor_uri FROM remote_actors a
         WHERE ${conditions.join(" AND ")}
         ORDER BY a.username, a.domain, a.actor_uri LIMIT ? OFFSET ?`,
      )
      .bind(...binds, filters.limit, filters.offset)
      .all();
    return parseRows(ActorUriRow, results).map((row) => row.actor_uri);
  });
