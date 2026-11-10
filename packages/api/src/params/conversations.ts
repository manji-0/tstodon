import type { z } from "zod";
import { ApiPaginationParamsSchema } from "./pagination";

/** `GET /api/v1/conversations`. */
export const ApiGetConversationsParamsSchema = ApiPaginationParamsSchema;
export type ApiGetConversationsParams = z.input<typeof ApiGetConversationsParamsSchema>;
