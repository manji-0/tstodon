import { schemaResult } from "@tstodon/core";
import { z } from "zod";

export const InstanceRuleSchema = z.object({
  kind: z.literal("InstanceRule"),
  id: z.string().min(1),
  text: z.string().min(1),
});

export type InstanceRule = z.infer<typeof InstanceRuleSchema>;

export const InstanceRule = {
  schema: InstanceRuleSchema,
  parse: schemaResult(InstanceRuleSchema),
  fromText: (text: string, index: number): InstanceRule =>
    ({
      kind: "InstanceRule",
      id: String(index + 1),
      text,
    }) as const satisfies InstanceRule,
} as const;
