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

/** `object` is the account the actor blocks. */
const BlockSchema = z.object({
  kind: z.literal("Block"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});

/** `object` is the account that moved; its `target` is read from the raw activity. */
const MoveSchema = z.object({
  kind: z.literal("Move"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});

/**
 * A report from another server. `object` is the first object it lists; the
 * rest, and the `content` comment, are read from the raw activity.
 */
const FlagSchema = z.object({
  kind: z.literal("Flag"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});

/**
 * FEP-044f: the actor asks to quote `object`; the quoting note is the
 * `instrument`, read from the raw activity.
 */
const QuoteRequestSchema = z.object({
  kind: z.literal("QuoteRequest"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});

/**
 * The actor adds `object` to a collection of its own, named by the `target`
 * read from the raw activity: a note to its `featured` collection is a pin.
 */
const AddSchema = z.object({
  kind: z.literal("Add"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});

/** The actor removes `object` from the collection its `target` names: an unpin. */
const RemoveSchema = z.object({
  kind: z.literal("Remove"),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: z.string().min(1),
});

const RelationshipActivitySchema = z.discriminatedUnion("kind", [
  FollowSchema,
  UndoSchema,
  AcceptSchema,
  RejectSchema,
  BlockSchema,
]);

export const ActivitySchema = z.discriminatedUnion("kind", [
  CreateSchema,
  UpdateSchema,
  DeleteSchema,
  RelationshipActivitySchema,
  MoveSchema,
  LikeSchema,
  AnnounceSchema,
  FlagSchema,
  QuoteRequestSchema,
  AddSchema,
  RemoveSchema,
]);

export type Activity = z.infer<typeof ActivitySchema>;

export const Activity = {
  schema: ActivitySchema,
  parse: schemaResult(ActivitySchema),
} as const;
