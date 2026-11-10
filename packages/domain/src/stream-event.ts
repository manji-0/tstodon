import type { ApiConversationJSON, ApiNotificationJSON, ApiStatusJSON } from "@tstodon/api";
import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";
import { StatusId } from "./status-id";

/**
 * A payload typed as the `@tstodon/api` entity the streaming contract
 * (`ApiStreamingEvent`) gives its event. The publishers build it with that
 * type, so the hub only checks that it is an object and does not parse the
 * document again on every delivery; the stream tests parse what reaches a
 * client with the contract's schemas.
 */
const entity = <T extends object>() =>
  z.custom<T>((value) => typeof value === "object" && value !== null);

const UpdateSchema = z.object({
  kind: z.literal("update"),
  payload: entity<ApiStatusJSON>(),
});
const DeleteSchema = z.object({
  kind: z.literal("delete"),
  statusId: StatusId.schema,
});
const NotificationSchema = z.object({
  kind: z.literal("notification"),
  payload: entity<ApiNotificationJSON>(),
});
const StatusUpdateSchema = z.object({
  kind: z.literal("status.update"),
  payload: entity<ApiStatusJSON>(),
});
/** A Conversation entity on the `direct` stream: a direct message arrived or moved one. */
const ConversationSchema = z.object({
  kind: z.literal("conversation"),
  payload: entity<ApiConversationJSON>(),
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
