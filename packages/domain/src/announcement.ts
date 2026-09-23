import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { IsoInstant } from "./iso-instant";

export const AnnouncementSchema = z.object({
  kind: z.literal("Announcement"),
  id: z.string().min(1),
  content: z.string().min(1),
  publishedAt: IsoInstant.schema,
  updatedAt: IsoInstant.schema,
  startsAt: IsoInstant.schema.nullable(),
  endsAt: IsoInstant.schema.nullable(),
  allDay: z.boolean(),
});

export type Announcement = z.infer<typeof AnnouncementSchema>;

export const Announcement = {
  schema: AnnouncementSchema,
  parse: schemaResult(AnnouncementSchema),
} as const;
