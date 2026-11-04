import { getAdminTrends, postAdminTrends } from "#src/routes/admin-web/trends";

export const GET = getAdminTrends("tags");
export const POST = postAdminTrends("tags");
