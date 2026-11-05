import { schemaResult } from "@tstodon/core";
import { z } from "zod";

/**
 * Where a report stands in Mastodon's moderation workflow: open until a
 * moderator resolves it, and open again when one reopens it. Mastodon keeps
 * the resolution as `action_taken_at` / `action_taken_by_account`, which are
 * set and cleared together.
 */
const schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Open") }),
  z.object({
    kind: z.literal("Resolved"),
    at: z.string().min(1),
    byAccountId: z.string().min(1),
  }),
]);

export type ReportResolution = z.infer<typeof schema>;

const open: ReportResolution = { kind: "Open" };

export const ReportResolution = {
  schema,
  parse: schemaResult(schema),
  open,
  /**
   * A report a moderator resolved. Either state moves to either: resolving a
   * resolved report stamps it again, as Mastodon's `resolve!` does, and
   * reopening an open one leaves it open.
   */
  resolved: (byAccountId: string, at: string): ReportResolution => ({
    kind: "Resolved",
    at,
    byAccountId,
  }),
} as const;
