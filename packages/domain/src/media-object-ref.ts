import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";

const NoneSchema = unitKind("None");
const PresentSchema = z.object({
  kind: z.literal("Present"),
  value: z.string().min(1),
});

export const MediaObjectRefSchema = z.discriminatedUnion("kind", [NoneSchema, PresentSchema]);

export type MediaObjectRef = z.infer<typeof MediaObjectRefSchema>;

export const MediaObjectRef = {
  schema: MediaObjectRefSchema,
  parse: schemaResult(MediaObjectRefSchema),
  none: { kind: "None" } as const satisfies MediaObjectRef,
  present: (value: string): MediaObjectRef => ({ kind: "Present", value }),
  fromNullable: (value: string | null | undefined): MediaObjectRef =>
    value && value.length > 0 ? { kind: "Present", value } : { kind: "None" },
} as const;
