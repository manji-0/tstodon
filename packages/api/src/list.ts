import { z } from "zod";
import { LIST_REPLIES_POLICIES } from "./values";

/** `REST::ListSerializer`. */
export const ApiList = z.object({
  id: z.string(),
  title: z.string(),
  replies_policy: z.literal(LIST_REPLIES_POLICIES),
  exclusive: z.boolean(),
});
export type ApiListJSON = z.infer<typeof ApiList>;
