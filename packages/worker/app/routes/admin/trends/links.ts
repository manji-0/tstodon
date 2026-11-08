import { getAdminTrends, postAdminTrends } from "#server/routes/admin-web/trends";

export const GET = getAdminTrends("links");
export const POST = postAdminTrends("links");
