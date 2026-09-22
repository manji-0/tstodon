import { Visibility, type LocalStatus } from "@tstodon/domain";
import { isAccountMentionedOnStatus } from "./mention-store";
import { relationshipFlags } from "./social-store";
import { findStatusById } from "./status-store";

const canViewDirectStatus = async (
  db: D1Database,
  status: Extract<LocalStatus, { kind: "LocalNote" }>,
  viewerId: string,
): Promise<boolean> => {
  if (viewerId === status.accountId) {
    return true;
  }
  const mentioned = await isAccountMentionedOnStatus(db, status.id, viewerId);
  if (mentioned.isOk() && mentioned.value) {
    return true;
  }
  if (!status.inReplyToId) {
    return false;
  }
  const parent = await findStatusById(db, status.inReplyToId);
  if (parent.isErr() || !parent.value || parent.value.kind !== "LocalNote") {
    return false;
  }
  if (parent.value.visibility.kind !== "Direct") {
    return false;
  }
  return canViewDirectStatus(db, parent.value, viewerId);
};

export const canViewStatus = async (
  db: D1Database,
  status: LocalStatus,
  viewerId: string | undefined,
): Promise<boolean> => {
  if (status.kind === "LocalReblog") {
    return true;
  }
  if (status.visibility.kind === "Direct") {
    if (!viewerId) {
      return false;
    }
    return canViewDirectStatus(db, status, viewerId);
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
