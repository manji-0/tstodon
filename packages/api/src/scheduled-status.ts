import { z } from "zod";
import { ApiMediaAttachment } from "./media-attachment";
import { QUOTE_POLICIES, STATUS_VISIBILITIES } from "./values";

/** `REST::ScheduledStatusSerializer`: the post's parameters as they were sent. */
export const ApiScheduledStatus = z.object({
  id: z.string(),
  scheduled_at: z.string(),
  params: z.object({
    text: z.string(),
    media_ids: z.array(z.string()).nullable(),
    sensitive: z.boolean().nullable(),
    spoiler_text: z.string().nullable(),
    visibility: z.literal(STATUS_VISIBILITIES).nullable(),
    language: z.string().nullable(),
    scheduled_at: z.string().nullable(),
    poll: z
      .object({
        options: z.array(z.string()),
        expires_in: z.number(),
        multiple: z.boolean().optional(),
        hide_totals: z.boolean().optional(),
      })
      .nullable(),
    idempotency: z.string().nullable(),
    with_rate_limit: z.boolean(),
    in_reply_to_id: z.string().nullable(),
    quoted_status_id: z.string().nullable().optional(),
    quote_approval_policy: z.literal(QUOTE_POLICIES).nullable().optional(),
    application_id: z.string().nullable(),
  }),
  media_attachments: z.array(ApiMediaAttachment),
});
export type ApiScheduledStatusJSON = z.infer<typeof ApiScheduledStatus>;
