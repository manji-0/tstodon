import { z } from "zod";
import { ApiPaginationParamsSchema } from "./pagination";

/** `POST /api/v1/featured_tags`: the hashtag's name, without `#`. */
export const ApiCreateFeaturedTagParamsSchema = z.object({
  name: z.string().min(1),
});
export type ApiCreateFeaturedTagParams = z.input<typeof ApiCreateFeaturedTagParamsSchema>;

/** `GET /api/v1/followed_tags`. tstodon answers every followed tag in one page. */
export const ApiGetFollowedTagsParamsSchema = ApiPaginationParamsSchema;
export type ApiGetFollowedTagsParams = z.input<typeof ApiGetFollowedTagsParamsSchema>;
