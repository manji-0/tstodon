import { z } from "zod";
import { ApiPaginationParamsSchema } from "./pagination";

/**
 * `GET /api/v1/accounts/lookup?acct=`: an account by its webfinger address
 * (`user` or `user@domain`). Without `acct` the server answers 404, as
 * Mastodon.
 */
export const ApiLookupAccountParamsSchema = z.object({
  acct: z.string(),
});
export type ApiLookupAccountParams = z.input<typeof ApiLookupAccountParamsSchema>;

/**
 * `GET /api/v1/accounts/relationships?id[]=`. `with_suspended` (Mastodon
 * 4.3) also answers for suspended accounts; tstodon answers for every
 * requested id either way, so it changes nothing.
 */
export const ApiGetRelationshipsParamsSchema = z.object({
  id: z.array(z.string()).optional(),
  with_suspended: z.boolean().optional(),
});
export type ApiGetRelationshipsParams = z.input<typeof ApiGetRelationshipsParamsSchema>;

/**
 * `POST /api/v1/accounts/:id/mute`. `notifications` (default true) also
 * hides the account's notifications; `duration` is in seconds, 0 (the
 * default) for a mute that does not expire. `null` reads as the default.
 */
export const ApiMuteAccountParamsSchema = z.object({
  notifications: z.boolean().nullable().optional(),
  duration: z.number().nullable().optional(),
});
export type ApiMuteAccountParams = z.input<typeof ApiMuteAccountParamsSchema>;

/**
 * `GET /api/v1/accounts/:id/statuses`: an account's posts, paged.
 * `pinned` lists its pinned posts instead (not paged), `tagged` keeps the
 * posts with that hashtag (without `#`).
 */
export const ApiGetAccountStatusesParamsSchema = ApiPaginationParamsSchema.extend({
  pinned: z.boolean().optional(),
  only_media: z.boolean().optional(),
  exclude_replies: z.boolean().optional(),
  exclude_reblogs: z.boolean().optional(),
  /** Mastodon API version 8: leave out direct posts. */
  exclude_direct: z.boolean().optional(),
  tagged: z.string().optional(),
});
export type ApiGetAccountStatusesParams = z.input<typeof ApiGetAccountStatusesParamsSchema>;
