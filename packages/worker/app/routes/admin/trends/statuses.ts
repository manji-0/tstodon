import { getAdminTrends, postAdminTrends } from "#server/routes/admin-web/trends";

export const GET = getAdminTrends("statuses");
export const POST = postAdminTrends("statuses");
