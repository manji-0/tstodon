import { z } from "zod";
import { ApiAccount } from "./account";
import { ApiStatus } from "./status";

/** `REST::ConversationSerializer`. */
export const ApiConversation = z.object({
  id: z.string(),
  unread: z.boolean(),
  accounts: z.array(ApiAccount),
  last_status: ApiStatus.nullable(),
});
export type ApiConversationJSON = z.infer<typeof ApiConversation>;
