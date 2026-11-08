import { z } from "zod";
import { ApiAccount } from "./account";
import { SUGGESTION_SOURCES } from "./values";

/** `REST::SuggestionSerializer` (`/api/v2/suggestions`). */
export const ApiSuggestion = z.object({
  source: z.string().optional(),
  sources: z.tuple([z.literal(SUGGESTION_SOURCES)], z.literal(SUGGESTION_SOURCES)),
  account: ApiAccount,
});
export type ApiSuggestionJSON = z.infer<typeof ApiSuggestion>;
