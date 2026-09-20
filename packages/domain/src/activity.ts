import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { ActivityId } from "./activity-id";

const CreateSchema = z.object({
  kind: z.literal("Create"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});
const UpdateSchema = z.object({
  kind: z.literal("Update"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});
const DeleteSchema = z.object({
  kind: z.literal("Delete"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});
const FollowSchema = z.object({
  kind: z.literal("Follow"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});
const UndoSchema = z.object({
  kind: z.literal("Undo"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});
const AcceptSchema = z.object({
  kind: z.literal("Accept"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});
const RejectSchema = z.object({
  kind: z.literal("Reject"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});
const LikeSchema = z.object({
  kind: z.literal("Like"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});
const AnnounceSchema = z.object({
  kind: z.literal("Announce"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});

const RelationshipActivitySchema = z.discriminatedUnion("kind", [
  FollowSchema,
  UndoSchema,
  AcceptSchema,
  RejectSchema,
]);

export const ActivitySchema = z.discriminatedUnion("kind", [
  CreateSchema,
  UpdateSchema,
  DeleteSchema,
  RelationshipActivitySchema,
  LikeSchema,
  AnnounceSchema,
]);

export type Activity = z.infer<typeof ActivitySchema>;

export const Activity = {
  schema: ActivitySchema,
  parse: schemaResult(ActivitySchema),
} as const;
