import { z } from "zod";

/**
 * `POST /api/v1/polls/:id/votes`: the chosen options' indexes. Mastodon
 * documents them as strings; JSON clients send numbers too.
 */
export const ApiPollVoteParamsSchema = z.object({
  choices: z.array(z.union([z.number(), z.string()])),
});
export type ApiPollVoteParams = z.input<typeof ApiPollVoteParamsSchema>;
