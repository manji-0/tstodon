import { schemaResult } from "@tstodon/core";
import { z } from "zod";

/**
 * Whether a report was sent on to the target's server as a `Flag`. Only a
 * report against a remote account can be forwarded; a local target's report
 * stays here.
 */
const schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("NotForwarded") }),
  z.object({ kind: z.literal("Forwarded") }),
]);

export type ReportForwarding = z.infer<typeof schema>;

export const ReportForwarding = {
  schema,
  parse: schemaResult(schema),
  notForwarded: { kind: "NotForwarded" } as const satisfies ReportForwarding,
  forwarded: { kind: "Forwarded" } as const satisfies ReportForwarding,
} as const;
