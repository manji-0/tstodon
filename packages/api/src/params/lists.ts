import { z } from "zod";
import { LIST_REPLIES_POLICIES } from "../values";
import { ApiPaginationParamsSchema } from "./pagination";

/** `POST /api/v1/lists`. */
export const ApiCreateListParamsSchema = z.object({
  title: z.string().min(1),
  replies_policy: z.literal(LIST_REPLIES_POLICIES).optional(),
  exclusive: z.boolean().optional(),
});
export type ApiCreateListParams = z.input<typeof ApiCreateListParamsSchema>;

/** `PUT /api/v1/lists/:id`: what is left out keeps its value. */
export const ApiUpdateListParamsSchema = z.object({
  title: z.string().min(1).optional(),
  replies_policy: z.literal(LIST_REPLIES_POLICIES).optional(),
  exclusive: z.boolean().optional(),
});
export type ApiUpdateListParams = z.input<typeof ApiUpdateListParamsSchema>;

/**
 * `POST` and `DELETE /api/v1/lists/:id/accounts`. Mastodon reads them from
 * the body or the query (the web UI sends the `DELETE`'s in the query).
 */
export const ApiListAccountsParamsSchema = z.object({
  account_ids: z.array(z.string()),
});
export type ApiListAccountsParams = z.input<typeof ApiListAccountsParamsSchema>;

/** `GET /api/v1/lists/:id/accounts` (`limit=0`: all). tstodon answers every member in one page. */
export const ApiGetListAccountsParamsSchema = ApiPaginationParamsSchema;
export type ApiGetListAccountsParams = z.input<typeof ApiGetListAccountsParamsSchema>;
