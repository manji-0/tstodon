import {
  Visibility,
  type LocalStatus,
  type RemoteStatus,
  type Visibility as VisibilityValue,
} from "@tstodon/domain";
import { remoteStatusVisible } from "./mastodon";
import { isAccountMentionedOnStatus } from "./mention-store";
import { isAccountMentionedOnRemoteStatus } from "./remote-status-store";
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

/** Visible to everyone when public/unlisted, otherwise to the author and followers. */
const canViewRestricted = async (
  db: D1Database,
  visibility: VisibilityValue,
  authorId: string,
  viewerId: string | undefined,
): Promise<boolean> => {
  if (!Visibility.isRestricted(visibility)) {
    return true;
  }
  if (viewerId === authorId) {
    return true;
  }
  if (!viewerId) {
    return false;
  }
  const flags = await relationshipFlags(db, viewerId, authorId);
  return flags.isOk() && flags.value.following;
};

export const canViewStatus = async (
  db: D1Database,
  status: LocalStatus,
  viewerId: string | undefined,
): Promise<boolean> => {
  // A boost's own visibility decides who sees it; it is never direct.
  if (status.kind === "LocalReblog") {
    return canViewRestricted(db, status.visibility, status.accountId, viewerId);
  }
  if (status.visibility.kind === "Direct") {
    if (!viewerId) {
      return false;
    }
    return canViewDirectStatus(db, status, viewerId);
  }
  return canViewRestricted(db, status.visibility, status.accountId, viewerId);
};

/**
 * A cached remote status: public and unlisted ones are open, and a direct or
 * followers-only one is shown to the local accounts it addresses.
 */
export const canViewRemoteStatus = async (
  db: D1Database,
  status: RemoteStatus,
  viewerId: string | undefined,
): Promise<boolean> => {
  if (remoteStatusVisible(status)) {
    return true;
  }
  if (!viewerId) {
    return false;
  }
  const mentioned = await isAccountMentionedOnRemoteStatus(db, status.id, viewerId);
  return mentioned.isOk() && mentioned.value;
};
