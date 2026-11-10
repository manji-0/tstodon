import { z } from "zod";

/**
 * `POST /api/v1/reports`. `category` is `spam`, `legal`, `violation` or
 * `other` (the default); the server checks it (422 when unknown), so it is a
 * string here. `rule_ids` are the instance's rule ids, kept for `violation`
 * reports only. `forward` sends a report on a remote account to its server;
 * `forward_to_domains` names the servers of the accounts the reported posts
 * reply to that should get it too. tstodon has no collections:
 * `collection_ids` (Mastodon 4.6) is read and ignored.
 */
export const ApiCreateReportParamsSchema = z.object({
  account_id: z.string().min(1),
  status_ids: z.array(z.string()).optional(),
  collection_ids: z.array(z.string()).optional(),
  comment: z.string().optional(),
  category: z.string().optional(),
  rule_ids: z.array(z.union([z.string(), z.number()])).optional(),
  forward: z.boolean().optional(),
  forward_to_domains: z.array(z.string()).optional(),
});
export type ApiCreateReportParams = z.input<typeof ApiCreateReportParamsSchema>;
