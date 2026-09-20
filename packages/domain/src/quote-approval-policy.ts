import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";

const PublicSchema = unitKind("Public");
const FollowersSchema = unitKind("Followers");
const NobodySchema = unitKind("Nobody");

export const QuoteApprovalPolicySchema = z.discriminatedUnion("kind", [
  PublicSchema,
  FollowersSchema,
  NobodySchema,
]);

export type QuoteApprovalPolicy = z.infer<typeof QuoteApprovalPolicySchema>;

export const QuoteApprovalPolicy = {
  schema: QuoteApprovalPolicySchema,
  parse: schemaResult(QuoteApprovalPolicySchema),
  Public: { kind: "Public" } as const satisfies QuoteApprovalPolicy,
  Followers: { kind: "Followers" } as const satisfies QuoteApprovalPolicy,
  Nobody: { kind: "Nobody" } as const satisfies QuoteApprovalPolicy,
} as const;
