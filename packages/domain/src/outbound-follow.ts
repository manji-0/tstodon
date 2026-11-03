import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";

const RequestedSchema = unitKind("Requested");
const AcceptedSchema = unitKind("Accepted");

/** Whether the followed remote actor has answered the `Follow` with `Accept` yet. */
export const OutboundFollowStateSchema = z.discriminatedUnion("kind", [
  RequestedSchema,
  AcceptedSchema,
]);

export type OutboundFollowState = z.infer<typeof OutboundFollowStateSchema>;

/**
 * A local account following a remote actor. `followActivityId` is the id of
 * the `Follow` sent to the actor, which its `Accept`, `Reject`, and our
 * `Undo` refer to.
 */
export const OutboundFollowSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  actorUri: z.string().min(1),
  followActivityId: z.string().min(1),
  state: OutboundFollowStateSchema,
  reblogs: z.boolean(),
  notify: z.boolean(),
  languages: z.array(z.string()),
  createdAt: z.string().min(1),
});

export type OutboundFollow = z.infer<typeof OutboundFollowSchema>;

export const OutboundFollow = {
  schema: OutboundFollowSchema,
  parse: schemaResult(OutboundFollowSchema),
  stateSchema: OutboundFollowStateSchema,
  parseState: schemaResult(OutboundFollowStateSchema),
  Requested: { kind: "Requested" } as const satisfies OutboundFollowState,
  Accepted: { kind: "Accepted" } as const satisfies OutboundFollowState,
  /** Mastodon's `following` / `requested` relationship flags for a follow, or for none. */
  relationship: (
    follow: OutboundFollow | undefined,
  ): Readonly<{ following: boolean; requested: boolean }> => ({
    following: follow?.state.kind === "Accepted",
    requested: follow?.state.kind === "Requested",
  }),
} as const;
