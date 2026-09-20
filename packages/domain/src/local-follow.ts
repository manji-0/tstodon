import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";

const PendingSchema = unitKind("Pending");
const AcceptedSchema = unitKind("Accepted");

export const LocalFollowSchema = z.discriminatedUnion("kind", [
  PendingSchema,
  AcceptedSchema,
]);

export type LocalFollow = z.infer<typeof LocalFollowSchema>;
export type PendingLocalFollow = z.infer<typeof PendingSchema>;
export type AcceptedLocalFollow = z.infer<typeof AcceptedSchema>;

export const LocalFollow = {
  schema: LocalFollowSchema,
  parse: schemaResult(LocalFollowSchema),
  Pending: { kind: "Pending" } as const satisfies PendingLocalFollow,
  Accepted: { kind: "Accepted" } as const satisfies AcceptedLocalFollow,
  initial: (targetLocked: boolean): LocalFollow =>
    targetLocked ? LocalFollow.Pending : LocalFollow.Accepted,
  authorize: (_current: LocalFollow): AcceptedLocalFollow => LocalFollow.Accepted,
  existsAfterReject: (current: LocalFollow): boolean => current.kind === "Accepted",
  notificationKind: (
    state: LocalFollow,
  ): "follow_request" | "follow" =>
    state.kind === "Pending" ? "follow_request" : "follow",
} as const;
