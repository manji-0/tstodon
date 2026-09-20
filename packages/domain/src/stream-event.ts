import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { StatusId } from "./status-id";

const UpdateSchema = z.object({
  kind: z.literal("update"),
  payload: z.unknown(),
});
const DeleteSchema = z.object({
  kind: z.literal("delete"),
  statusId: StatusId.schema,
});
const NotificationSchema = z.object({
  kind: z.literal("notification"),
  payload: z.unknown(),
});
const StatusUpdateSchema = z.object({
  kind: z.literal("status.update"),
  payload: z.unknown(),
});

export const StreamEventSchema = z.discriminatedUnion("kind", [
  UpdateSchema,
  DeleteSchema,
  NotificationSchema,
  StatusUpdateSchema,
]);

export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const StreamEvent = {
  schema: StreamEventSchema,
  parse: schemaResult(StreamEventSchema),
} as const;
