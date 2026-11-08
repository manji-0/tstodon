import { z } from "zod";
import { ApiCustomEmoji } from "./custom-emoji";

/** `Poll#options[]`: `votes_count` is null while a poll that hides totals runs. */
export const ApiPollOption = z.object({
  title: z.string(),
  votes_count: z.number().nullable(),
});
export type ApiPollOptionJSON = z.infer<typeof ApiPollOption>;

/** `REST::PollSerializer`; `voted` and `own_votes` only for a signed-in viewer. */
export const ApiPoll = z.object({
  id: z.string(),
  expires_at: z.string().nullable(),
  expired: z.boolean(),
  multiple: z.boolean(),
  votes_count: z.number(),
  voters_count: z.number().nullable(),
  options: z.array(ApiPollOption),
  emojis: z.array(ApiCustomEmoji),
  voted: z.boolean().optional(),
  own_votes: z.array(z.number()).optional(),
});
export type ApiPollJSON = z.infer<typeof ApiPoll>;
