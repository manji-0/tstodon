import { z } from "zod";
import { ApiAccount } from "./account";
import { REPORT_CATEGORIES } from "./values";

/** `REST::ReportSerializer`. */
export const ApiReport = z.object({
  id: z.string(),
  action_taken: z.boolean(),
  action_taken_at: z.string().nullable(),
  category: z.literal(REPORT_CATEGORIES),
  comment: z.string(),
  forwarded: z.boolean(),
  created_at: z.string(),
  status_ids: z.array(z.string()),
  rule_ids: z.array(z.string()).nullable(),
  target_account: ApiAccount,
});
export type ApiReportJSON = z.infer<typeof ApiReport>;
