import { getAdminTrends, postAdminTrends } from "#src/routes/admin-web/trends";

export const GET = getAdminTrends("links");
export const POST = postAdminTrends("links");
