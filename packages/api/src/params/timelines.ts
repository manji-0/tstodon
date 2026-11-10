import { z } from "zod";
import { ApiPaginationParamsSchema } from "./pagination";

/** `GET /api/v1/timelines/home`. */
export const ApiGetHomeTimelineParamsSchema = ApiPaginationParamsSchema;
export type ApiGetHomeTimelineParams = z.input<typeof ApiGetHomeTimelineParamsSchema>;

/**
 * `local` / `remote` / `only_media` of the public and tag timelines:
 * `local=true` keeps local statuses, `remote=true` remote ones, neither (or
 * both) keeps both.
 */
const TimelineScopeParams = ApiPaginationParamsSchema.extend({
  local: z.boolean().optional(),
  remote: z.boolean().optional(),
  only_media: z.boolean().optional(),
});

/** `GET /api/v1/timelines/public`. */
export const ApiGetPublicTimelineParamsSchema = TimelineScopeParams;
export type ApiGetPublicTimelineParams = z.input<typeof ApiGetPublicTimelineParamsSchema>;

/**
 * `GET /api/v1/timelines/tag/:hashtag`: `any`, `all` and `none` name
 * additional tags (a leading `#` is dropped, at most four apply, `any`
 * first).
 */
export const ApiGetTagTimelineParamsSchema = TimelineScopeParams.extend({
  any: z.array(z.string()).optional(),
  all: z.array(z.string()).optional(),
  none: z.array(z.string()).optional(),
});
export type ApiGetTagTimelineParams = z.input<typeof ApiGetTagTimelineParamsSchema>;

/** `GET /api/v1/timelines/list/:id`. */
export const ApiGetListTimelineParamsSchema = ApiPaginationParamsSchema;
export type ApiGetListTimelineParams = z.input<typeof ApiGetListTimelineParamsSchema>;

/**
 * `GET /api/v1/timelines/link`: `url` is the trending link. Without one the
 * link is not trending, so the answer is a 404, not a validation error.
 */
export const ApiGetLinkTimelineParamsSchema = ApiPaginationParamsSchema.extend({
  url: z.string().optional(),
});
export type ApiGetLinkTimelineParams = z.input<typeof ApiGetLinkTimelineParamsSchema>;
