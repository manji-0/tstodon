import { z } from "zod";

/** `REST::RelationshipSerializer`. */
export const ApiRelationship = z.object({
  id: z.string(),
  following: z.boolean(),
  showing_reblogs: z.boolean(),
  notifying: z.boolean(),
  languages: z.array(z.string()).nullable(),
  followed_by: z.boolean(),
  blocking: z.boolean(),
  blocked_by: z.boolean(),
  muting: z.boolean(),
  muting_notifications: z.boolean(),
  muting_expires_at: z.string().nullable(),
  requested: z.boolean(),
  requested_by: z.boolean(),
  domain_blocking: z.boolean(),
  endorsed: z.boolean(),
  note: z.string(),
});
export type ApiRelationshipJSON = z.infer<typeof ApiRelationship>;
