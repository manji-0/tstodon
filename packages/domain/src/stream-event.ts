import { schemaResult, unitKind } from "@tstodon/core";
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
/** A Conversation entity on the `direct` stream: a direct message arrived or moved one. */
const ConversationSchema = z.object({
  kind: z.literal("conversation"),
  payload: z.unknown(),
});
/** Mastodon's event telling clients that accepted requests have merged. */
const NotificationsMergedSchema = unitKind("notifications_merged");

export const StreamEventSchema = z.discriminatedUnion("kind", [
  UpdateSchema,
  DeleteSchema,
  NotificationSchema,
  StatusUpdateSchema,
  ConversationSchema,
  NotificationsMergedSchema,
]);

export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const StreamEvent = {
  schema: StreamEventSchema,
  parse: schemaResult(StreamEventSchema),
} as const;
