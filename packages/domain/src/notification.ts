import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { AccountId } from "./account-id";
import { IsoInstant } from "./iso-instant";
import { StatusId } from "./status-id";

const FollowSchema = z.object({
  kind: z.literal("follow"),
  id: z.string().min(1),
  accountId: AccountId.schema,
  createdAt: IsoInstant.schema,
});
const FavouriteSchema = z.object({
  kind: z.literal("favourite"),
  id: z.string().min(1),
  accountId: AccountId.schema,
  statusId: StatusId.schema,
  createdAt: IsoInstant.schema,
});
const ReblogSchema = z.object({
  kind: z.literal("reblog"),
  id: z.string().min(1),
  accountId: AccountId.schema,
  statusId: StatusId.schema,
  createdAt: IsoInstant.schema,
});
const MentionSchema = z.object({
  kind: z.literal("mention"),
  id: z.string().min(1),
  accountId: AccountId.schema,
  statusId: StatusId.schema,
  createdAt: IsoInstant.schema,
});
const PollSchema = z.object({
  kind: z.literal("poll"),
  id: z.string().min(1),
  accountId: AccountId.schema,
  statusId: StatusId.schema,
  createdAt: IsoInstant.schema,
});

export const NotificationSchema = z.discriminatedUnion("kind", [
  FollowSchema,
  FavouriteSchema,
  ReblogSchema,
  MentionSchema,
  PollSchema,
]);

export type Notification = z.infer<typeof NotificationSchema>;

export const Notification = {
  schema: NotificationSchema,
  parse: schemaResult(NotificationSchema),
} as const;
