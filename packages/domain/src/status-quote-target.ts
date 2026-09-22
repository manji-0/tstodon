import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";
import { StatusId } from "./status-id";

const NoneSchema = unitKind("None");
const QuotedSchema = z.object({
  kind: z.literal("Quoted"),
  statusId: StatusId.schema,
});

export const StatusQuoteTargetSchema = z.discriminatedUnion("kind", [NoneSchema, QuotedSchema]);

export type StatusQuoteTarget = z.infer<typeof StatusQuoteTargetSchema>;

export const StatusQuoteTarget = {
  schema: StatusQuoteTargetSchema,
  parse: schemaResult(StatusQuoteTargetSchema),
  none: { kind: "None" } as const satisfies StatusQuoteTarget,
} as const;

const AbsentLanguageSchema = unitKind("None");
const PresentLanguageSchema = z.object({
  kind: z.literal("Present"),
  value: z.string().trim().min(1).toLowerCase(),
});

export const StatusLanguageSchema = z.discriminatedUnion("kind", [
  AbsentLanguageSchema,
  PresentLanguageSchema,
]);

export type StatusLanguage = z.infer<typeof StatusLanguageSchema>;

const AbsentPollSchema = unitKind("None");
const PresentPollSchema = z.object({
  kind: z.literal("Present"),
});

export const StatusPollPresenceSchema = z.discriminatedUnion("kind", [
  AbsentPollSchema,
  PresentPollSchema,
]);

export type StatusPollPresence = z.infer<typeof StatusPollPresenceSchema>;
