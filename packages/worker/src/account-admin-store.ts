import { z } from "zod";
import { type LocalAccount } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { type RepositoryError, runD1 } from "./d1";
import { queryTyped } from "./typed-sql";
import { listAdminAccountIds as listAdminAccountIdsSql } from "./generated/prisma/sql";
import { accountFromRow, parseAccountRow, STATUS_SQL } from "./account-store";

const IdRow = z.object({ id: z.string().nullable() });

/**
 * Mastodon's admin account filters. `origin`/`status` are the translated form
 * (`local`/`active` by default); the text filters are case-insensitive
 * substrings. States this instance cannot hold (`remote`, `disabled`,
 * `byDomain`, `ip`, `staff`) match nothing rather than being ignored.
 */
export type AdminAccountFilters = Readonly<{
  origin: "local" | "remote";
  status: "active" | "pending" | "disabled" | "silenced" | "suspended" | "sensitized";
  username?: string | undefined;
  displayName?: string | undefined;
  email?: string | undefined;
  byDomain?: string | undefined;
  ip?: string | undefined;
  staff?: boolean | undefined;
  cursor?: IdCursor | undefined;
  limit: number;
  offset: number;
}>;

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
    if (filters.byDomain || filters.ip || filters.staff) {
      // No domain (local only), no recorded IPs, no staff accounts.
      conditions.push("0");
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
    const accounts: LocalAccount[] = [];
    for (const raw of results ?? []) {
      const row = parseAccountRow(raw);
      if (row.isErr()) {
        continue;
      }
      const account = accountFromRow(row.value);
      if (account.isOk()) {
        accounts.push(account.value);
      }
    }
    return accounts;
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
    | "limit"
    | "offset"
  >,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  runD1(async () => {
    const standing = (comparison: string): string =>
      `COALESCE((SELECT moderation FROM remote_actor_moderation m WHERE m.actor_uri = a.actor_uri), '') ${comparison}`;
    const statusCondition: Record<AdminAccountFilters["status"], string> = {
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
    if (filters.email || filters.ip || filters.staff) {
      conditions.push("0");
    }
    const { results } = await db
      .prepare(
        `SELECT a.actor_uri FROM remote_actors a
         WHERE ${conditions.join(" AND ")}
         ORDER BY a.username, a.domain, a.actor_uri LIMIT ? OFFSET ?`,
      )
      .bind(...binds, filters.limit, filters.offset)
      .all<{ actor_uri: string }>();
    return (results ?? []).map((row) => row.actor_uri);
  });
