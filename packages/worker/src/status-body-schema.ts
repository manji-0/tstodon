import { warmSchemas } from "@tstodon/core";
import { z } from "zod";
import { booleanish } from "./form-values";

export const MediaAttributeSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  focus: z.string().optional(),
});

export type MediaAttribute = z.infer<typeof MediaAttributeSchema>;

export const CreateStatusBodySchema = z.object({
  status: z.string().optional(),
  spoiler_text: z.string().optional(),
  sensitive: booleanish,
  visibility: z.string().optional(),
  language: z.string().optional(),
  in_reply_to_id: z.string().optional(),
  scheduled_at: z.string().optional(),
  quoted_status_id: z.string().optional(),
  quote_approval_policy: z.string().optional(),
  media_ids: z.union([z.array(z.string()), z.string()]).optional(),
  media_attributes: z.array(MediaAttributeSchema).optional(),
  poll: z
    .object({
      options: z.array(z.string()),
      expires_in: z.union([z.number(), z.string()]).optional(),
      multiple: booleanish,
      hide_totals: booleanish,
    })
    .optional(),
});

const MEDIA_ATTRIBUTE_KEY = /^media_attributes\[(\d+)\]\[(id|description|focus)\]$/;

/**
 * Mastodon clients may send `media_attributes[N][description]` as form data.
 * Hono exposes those as flat bracket keys, so pull them back into a list.
 */
export const mediaAttributesFromForm = (raw: unknown): ReadonlyArray<MediaAttribute> => {
  if (typeof raw !== "object" || raw === null) {
    return [];
  }
  const byIndex = new Map<number, { id?: string; description?: string; focus?: string }>();
  for (const [key, value] of Object.entries(raw)) {
    const match = MEDIA_ATTRIBUTE_KEY.exec(key);
    if (!match) {
      continue;
    }
    const index = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(index)) {
      continue;
    }
    const field = match[2];
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text !== "string") {
      continue;
    }
    const entry = byIndex.get(index) ?? {};
    if (field === "id") {
      entry.id = text;
    } else if (field === "description") {
      entry.description = text;
    } else {
      entry.focus = text;
    }
    byIndex.set(index, entry);
  }
  const attributes: MediaAttribute[] = [];
  for (const [, entry] of [...byIndex.entries()].toSorted(([left], [right]) => left - right)) {
    const id = entry.id;
    if (id !== undefined && id.length > 0) {
      attributes.push({ ...entry, id });
    }
  }
  return attributes;
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([CreateStatusBodySchema]);
