import { schemaResult } from "@tstodon/core";
import { z } from "zod";

export const CustomEmojiSchema = z.object({
  kind: z.literal("CustomEmoji"),
  shortcode: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z0-9_]+$/i),
  url: z.url(),
  staticUrl: z.url(),
  visibleInPicker: z.boolean(),
  category: z.string().min(1).optional(),
});

export type CustomEmoji = z.infer<typeof CustomEmojiSchema>;

export const CustomEmoji = {
  schema: CustomEmojiSchema,
  parse: schemaResult(CustomEmojiSchema),
} as const;
