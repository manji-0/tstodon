import { getAdminTrends, postAdminTrends } from "#server/routes/admin-web/trends";

export const GET = getAdminTrends("tags");
export const POST = postAdminTrends("tags");
