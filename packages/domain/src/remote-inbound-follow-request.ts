import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";

const AbsentSchema = unitKind("Absent");
const QueuedSchema = unitKind("Queued");
const FulfilledSchema = unitKind("Fulfilled");

export const RemoteInboundFollowRequestSchema = z.discriminatedUnion("kind", [
  AbsentSchema,
  QueuedSchema,
  FulfilledSchema,
]);

export type RemoteInboundFollowRequest = z.infer<typeof RemoteInboundFollowRequestSchema>;

export const RemoteInboundFollowRequest = {
  schema: RemoteInboundFollowRequestSchema,
  parse: schemaResult(RemoteInboundFollowRequestSchema),
  Absent: { kind: "Absent" } as const satisfies RemoteInboundFollowRequest,
  Queued: { kind: "Queued" } as const satisfies RemoteInboundFollowRequest,
  Fulfilled: { kind: "Fulfilled" } as const satisfies RemoteInboundFollowRequest,
  afterInboxFollow: (targetLocked: boolean): RemoteInboundFollowRequest =>
    targetLocked ? RemoteInboundFollowRequest.Queued : RemoteInboundFollowRequest.Fulfilled,
  authorize: (current: RemoteInboundFollowRequest): RemoteInboundFollowRequest =>
    current.kind === "Queued" ? RemoteInboundFollowRequest.Fulfilled : current,
  reject: (current: RemoteInboundFollowRequest): RemoteInboundFollowRequest =>
    current.kind === "Queued" ? RemoteInboundFollowRequest.Absent : current,
} as const;
