import { schemaResult, unitKind } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { ActivityId } from "./activity-id";
import { IsoInstant } from "./iso-instant";
import { RemoteStatus } from "./remote-status";
import { StatusId } from "./status-id";
import type { Visibility } from "./visibility";

/** The status a remote boost shares: a local note, or a cached remote one. */
export const RemoteBoostTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("LocalStatus"), statusId: StatusId.schema }),
  z.object({ kind: z.literal("RemoteStatus"), statusId: StatusId.schema }),
]);

export type RemoteBoostTarget = z.infer<typeof RemoteBoostTargetSchema>;

/** An `Announce` reaches the public, unlisted, or the booster's followers; a direct one is not kept. */
const RemoteBoostVisibilitySchema = z.discriminatedUnion("kind", [
  unitKind("Public"),
  unitKind("Unlisted"),
  unitKind("FollowersOnly"),
]);

/**
 * A remote actor's boost (`Announce`) of a status, kept as a home timeline
 * entry. Its `id` is in the same sortable id space as statuses, so it pages
 * with them.
 */
export const RemoteBoostSchema = z.object({
  kind: z.literal("RemoteBoost"),
  id: StatusId.schema,
  actorUri: z.url(),
  activityId: ActivityId.schema,
  target: RemoteBoostTargetSchema,
  visibility: RemoteBoostVisibilitySchema,
  publishedAt: IsoInstant.schema,
});

export type RemoteBoost = z.infer<typeof RemoteBoostSchema>;

export type RemoteBoostError = Readonly<{ kind: "NotAnnounceable" } | { kind: "DirectAudience" }>;

export const RemoteBoost = {
  schema: RemoteBoostSchema,
  parse: schemaResult(RemoteBoostSchema),
  targetSchema: RemoteBoostTargetSchema,
  /**
   * The boost an `Announce` makes. As in Mastodon, only a public or unlisted
   * status can be boosted, and the boost takes its visibility from the
   * `Announce`'s own `to`/`cc`.
   */
  fromAnnounce: (input: {
    id: StatusId;
    actorUri: string;
    activityId: ActivityId;
    target: RemoteBoostTarget;
    targetVisibility: Visibility;
    to: ReadonlyArray<string>;
    cc: ReadonlyArray<string>;
    publishedAt: IsoInstant;
  }): Result<RemoteBoost, RemoteBoostError> => {
    if (input.targetVisibility.kind !== "Public" && input.targetVisibility.kind !== "Unlisted") {
      return err({ kind: "NotAnnounceable" });
    }
    const visibility = RemoteStatus.visibilityFromAudience(input.to, input.cc);
    if (visibility.kind === "Direct") {
      return err({ kind: "DirectAudience" });
    }
    return ok({
      kind: "RemoteBoost",
      id: input.id,
      actorUri: input.actorUri,
      activityId: input.activityId,
      target: input.target,
      visibility,
      publishedAt: input.publishedAt,
    });
  },
} as const;
