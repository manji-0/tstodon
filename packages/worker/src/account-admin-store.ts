import { type LocalAccount } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { type RepositoryError, runD1 } from "./d1";
import { accountFromRow, parseAccountRow, STATUS_SQL } from "./account-store";

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
