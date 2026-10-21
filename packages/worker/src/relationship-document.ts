import type { RelationshipFlags } from "./social-store";

export const mastodonRelationship = (
  targetId: string,
  flags: RelationshipFlags,
): Record<string, unknown> => ({
  id: targetId,
  following: flags.following,
  showing_reblogs: flags.showingReblogs,
  notifying: flags.notifying,
  languages: [...flags.languages],
  followed_by: flags.followedBy,
  blocking: flags.blocking,
  blocked_by: flags.blockedBy,
  muting: flags.muting,
  muting_notifications: flags.mutingNotifications,
  muting_expires_at: flags.mutingExpiresAt,
  requested: flags.requested,
  domain_blocking: flags.domainBlocking,
  endorsed: flags.endorsed,
  note: flags.note,
});
