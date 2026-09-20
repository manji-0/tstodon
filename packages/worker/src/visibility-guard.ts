import { Visibility, type LocalStatus } from "@tstodon/domain";
import { relationshipFlags } from "./social-store";

export const canViewStatus = async (
  db: D1Database,
  status: LocalStatus,
  viewerId: string | undefined,
): Promise<boolean> => {
  if (status.kind === "LocalReblog") {
    return true;
  }
  if (!Visibility.isRestricted(status.visibility)) {
    return true;
  }
  if (viewerId === status.accountId) {
    return true;
  }
  if (!viewerId) {
    return false;
  }
  const flags = await relationshipFlags(db, viewerId, status.accountId);
  return flags.isOk() && flags.value.following;
};
