import { getAdminTrends, postAdminTrends } from "#src/routes/admin-web/trends";

export const GET = getAdminTrends("statuses");
export const POST = postAdminTrends("statuses");
