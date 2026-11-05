import { schemaResult } from "@tstodon/core";
import { z } from "zod";

/** Mastodon's `accept` / `filter` / `drop` handling for a notification category. */
const schema = z.union([z.literal("accept"), z.literal("filter"), z.literal("drop")]);

export type NotificationPolicyAction = z.infer<typeof schema>;

export const NotificationPolicyAction = {
  schema,
  parse: schemaResult(schema),
  /** `drop` over `filter` over `accept`; `accept` when nothing applies. */
  mostRestrictive: (actions: ReadonlyArray<NotificationPolicyAction>): NotificationPolicyAction => {
    if (actions.includes("drop")) {
      return "drop";
    }
    if (actions.includes("filter")) {
      return "filter";
    }
    return "accept";
  },
} as const;
