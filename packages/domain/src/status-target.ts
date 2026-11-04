import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { StatusId } from "./status-id";

/**
 * A status something points at: a local one in `statuses`, or a cached remote
 * one in `remote_statuses`. Both share one id space, so the kind says which
 * table holds it.
 */
export const StatusTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("LocalStatus"), statusId: StatusId.schema }),
  z.object({ kind: z.literal("RemoteStatus"), statusId: StatusId.schema }),
]);

export type StatusTarget = z.infer<typeof StatusTargetSchema>;

export const StatusTarget = {
  schema: StatusTargetSchema,
  parse: schemaResult(StatusTargetSchema),
  local: (statusId: StatusId): StatusTarget => ({ kind: "LocalStatus", statusId }),
  remote: (statusId: StatusId): StatusTarget => ({ kind: "RemoteStatus", statusId }),
} as const;
