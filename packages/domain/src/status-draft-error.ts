import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";

const EmptyPayloadSchema = unitKind("EmptyPayload");
const TooManyMediaSchema = z.object({
  kind: z.literal("TooManyMedia"),
  count: z.number().int().positive(),
});
const TooLongSchema = z.object({
  kind: z.literal("TooLong"),
  field: z.union([z.literal("text"), z.literal("spoiler_text")]),
  limit: z.number().int().positive(),
});
const PollWithMediaSchema = unitKind("PollWithMedia");
const QuoteWithMediaOrPollSchema = unitKind("QuoteWithMediaOrPoll");

export const StatusDraftErrorSchema = z.discriminatedUnion("kind", [
  EmptyPayloadSchema,
  TooLongSchema,
  TooManyMediaSchema,
  PollWithMediaSchema,
  QuoteWithMediaOrPollSchema,
]);

export type StatusDraftError = z.infer<typeof StatusDraftErrorSchema>;

export const StatusDraftError = {
  schema: StatusDraftErrorSchema,
  parse: schemaResult(StatusDraftErrorSchema),
} as const;
