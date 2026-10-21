import { z } from "zod";

export const MastodonAccountPreviewSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  acct: z.string().min(1),
  role: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      highlighted: z.boolean(),
    })
    .optional(),
});

export const MastodonStatusPreviewSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  favourited: z.boolean().optional(),
  favourites_count: z.number().optional(),
  reblogs_count: z.number().optional(),
  in_reply_to_id: z.string().nullable().optional(),
  in_reply_to_account_id: z.string().nullable().optional(),
  account: MastodonAccountPreviewSchema,
  poll: z
    .object({ id: z.string().min(1) })
    .nullable()
    .optional(),
});

export const MastodonContextPreviewSchema = z.object({
  ancestors: z.array(MastodonStatusPreviewSchema),
  descendants: z.array(MastodonStatusPreviewSchema),
});

export const MastodonAppPreviewSchema = z.object({
  name: z.string(),
  client_id: z.string(),
});

export const MastodonRelationshipPreviewSchema = z.object({
  id: z.string().min(1),
  following: z.boolean(),
});

export const MastodonNotificationPreviewSchema = z.object({
  type: z.string().min(1),
});

export const MastodonSearchPreviewSchema = z.object({
  accounts: z.array(MastodonAccountPreviewSchema),
});

export const MastodonFilterPreviewSchema = z.object({
  phrase: z.string(),
});

export const MastodonReportPreviewSchema = z.object({
  action_taken: z.boolean(),
});

export const MastodonStatusListPreviewSchema = z.array(MastodonStatusPreviewSchema);

export const MastodonNotificationListPreviewSchema = z.array(MastodonNotificationPreviewSchema);

export const MastodonRelationshipListPreviewSchema = z.array(MastodonRelationshipPreviewSchema);

export const MastodonMediaPreviewSchema = z.object({
  id: z.string().min(1),
});

export const WebfingerPreviewSchema = z.object({
  subject: z.string(),
});

export const ActorPreviewSchema = z.object({
  type: z.literal("Person"),
  preferredUsername: z.string(),
});

export const NotePreviewSchema = z.object({
  type: z.literal("Note"),
});
