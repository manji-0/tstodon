import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";

const SuccessSchema = unitKind("Success");
const TransientFailureSchema = unitKind("TransientFailure");
const PermanentFailureSchema = z.object({
  kind: z.literal("PermanentFailure"),
  httpStatus: z.number().int().min(400).max(499),
});

export const DeliveryAttemptOutcomeSchema = z.discriminatedUnion("kind", [
  SuccessSchema,
  TransientFailureSchema,
  PermanentFailureSchema,
]);

export type DeliveryAttemptOutcome = z.infer<typeof DeliveryAttemptOutcomeSchema>;

export const DeliveryAttemptOutcome = {
  schema: DeliveryAttemptOutcomeSchema,
  parse: schemaResult(DeliveryAttemptOutcomeSchema),
  Success: { kind: "Success" } as const satisfies DeliveryAttemptOutcome,
  TransientFailure: {
    kind: "TransientFailure",
  } as const satisfies DeliveryAttemptOutcome,
  forHttpStatus: (status: number): DeliveryAttemptOutcome => {
    if (status >= 200 && status <= 299) {
      return DeliveryAttemptOutcome.Success;
    }
    if (status === 408 || status === 429 || status < 400 || status >= 500) {
      return DeliveryAttemptOutcome.TransientFailure;
    }
    return { kind: "PermanentFailure", httpStatus: status };
  },
} as const;
