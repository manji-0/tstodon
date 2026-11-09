import { z } from "zod";
import { ApiCustomEmoji } from "./custom-emoji";

/** `REST::AnnouncementSerializer::ReactionSerializer`. */
export const ApiAnnouncementReaction = z.object({
  name: z.string(),
  count: z.number(),
  me: z.boolean().optional(),
  url: z.string().optional(),
  static_url: z.string().optional(),
});
export type ApiAnnouncementReactionJSON = z.infer<typeof ApiAnnouncementReaction>;

/** `REST::AnnouncementSerializer`: mentions, statuses and tags as references. */
export const ApiAnnouncement = z.object({
  id: z.string(),
  content: z.string(),
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  all_day: z.boolean(),
  published_at: z.string(),
  updated_at: z.string().nullable(),
  read: z.boolean().optional(),
  mentions: z.array(
    z.object({ id: z.string(), username: z.string(), url: z.string(), acct: z.string() }),
  ),
  statuses: z.array(z.object({ id: z.string(), url: z.string() })),
  tags: z.array(z.object({ name: z.string(), url: z.string() })),
  emojis: z.array(ApiCustomEmoji),
  reactions: z.array(ApiAnnouncementReaction),
});
export type ApiAnnouncementJSON = z.infer<typeof ApiAnnouncement>;
