import type { Context } from "hono";
import { dashboardPage } from "../../admin-content-pages";
import { adminDashboard } from "../../admin-dashboard-store";
import { instanceName } from "../account-settings";
import { adminSession, serverError } from "./shared";

/** Mastodon's `GET /admin/dashboard`, which `/admin` also opens. */
export const getAdminDashboard = async (c: Context<{ Bindings: Env }>) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const stats = await adminDashboard(c.env.DB, new Date());
  return stats.isErr()
    ? serverError(c, stats.error)
    : c.html(dashboardPage(instanceName(c.env), stats.value));
};
