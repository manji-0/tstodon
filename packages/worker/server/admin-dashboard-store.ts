import type { Result } from "neverthrow";
import { z } from "zod";
import { parseRow, type RepositoryError, runD1 } from "./d1";

/** The week the dashboard looks back over. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** What the admin dashboard counts. */
export type AdminDashboard = Readonly<{
  openReports: number;
  pendingApprovals: number;
  /** Local accounts created in the last 7 days. */
  signUpsLastWeek: number;
  /**
   * Local accounts seen in the last 7 days: a browser session refreshed, an
   * access token issued, or a post written. This server records no other
   * sign-in time.
   */
  activeUsersLastWeek: number;
}>;

const DashboardRowSchema = z.object({
  open_reports: z.number(),
  pending_approvals: z.number(),
  sign_ups: z.number(),
  active_users: z.number(),
});

export const adminDashboard = async (
  db: D1Database,
  now: Date,
): Promise<Result<AdminDashboard, RepositoryError>> =>
  runD1(async () => {
    const since = new Date(now.getTime() - WEEK_MS);
    const row = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM reports WHERE action_taken_at IS NULL) AS open_reports,
           (SELECT COUNT(*) FROM account_flags WHERE pending <> 0) AS pending_approvals,
           (SELECT COUNT(*) FROM accounts WHERE datetime(created_at) >= datetime(?1)) AS sign_ups,
           (SELECT COUNT(*) FROM accounts a WHERE
              a.auth_user_id IN (SELECT "userId" FROM "session" WHERE "updatedAt" >= ?2)
              OR a.id IN (SELECT account_id FROM oauth_access_tokens WHERE datetime(created_at) >= datetime(?1))
              OR a.id IN (SELECT account_id FROM statuses WHERE datetime(created_at) >= datetime(?1))
           ) AS active_users`,
      )
      .bind(since.toISOString(), since.getTime())
      .first();
    const counts = parseRow(DashboardRowSchema, row);
    if (counts.isErr()) {
      throw new Error(counts.error.message);
    }
    return {
      openReports: counts.value.open_reports,
      pendingApprovals: counts.value.pending_approvals,
      signUpsLastWeek: counts.value.sign_ups,
      activeUsersLastWeek: counts.value.active_users,
    };
  });
