import { schemaResult, unitKind } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { ActivityId } from "./activity-id";
import { IsoInstant } from "./iso-instant";
import { RemoteStatus } from "./remote-status";
import { StatusId } from "./status-id";
import { type StatusTarget, StatusTargetSchema } from "./status-target";
import type { Visibility } from "./visibility";

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
  target: StatusTargetSchema,
  visibility: RemoteBoostVisibilitySchema,
  publishedAt: IsoInstant.schema,
});

export type RemoteBoost = z.infer<typeof RemoteBoostSchema>;

export type RemoteBoostError = Readonly<{ kind: "NotAnnounceable" } | { kind: "DirectAudience" }>;

export const RemoteBoost = {
  schema: RemoteBoostSchema,
  parse: schemaResult(RemoteBoostSchema),
  /**
   * The boost an `Announce` makes. As Mastodon's `announceable?`, a public
   * or unlisted status can be boosted by anyone, and a followers-only one by
   * its own author. The boost takes its visibility from the `Announce`'s own
   * `to`/`cc`; the boost of a followers-only status reaches followers only,
   * whatever its audience says.
   */
  fromAnnounce: (input: {
    id: StatusId;
    actorUri: string;
    activityId: ActivityId;
    target: StatusTarget;
    targetVisibility: Visibility;
    /** The remote actor that wrote the target; `undefined` for a local status. */
    targetAuthorUri: string | undefined;
    to: ReadonlyArray<string>;
    cc: ReadonlyArray<string>;
    publishedAt: IsoInstant;
  }): Result<RemoteBoost, RemoteBoostError> => {
    const ownFollowersOnly =
      input.targetVisibility.kind === "FollowersOnly" && input.targetAuthorUri === input.actorUri;
    if (
      !ownFollowersOnly &&
      input.targetVisibility.kind !== "Public" &&
      input.targetVisibility.kind !== "Unlisted"
    ) {
      return err({ kind: "NotAnnounceable" });
    }
    const audience = RemoteStatus.visibilityFromAudience(input.to, input.cc);
    if (audience.kind === "Direct") {
      return err({ kind: "DirectAudience" });
    }
    return ok({
      kind: "RemoteBoost",
      id: input.id,
      actorUri: input.actorUri,
      activityId: input.activityId,
      target: input.target,
      visibility: ownFollowersOnly ? { kind: "FollowersOnly" } : audience,
      publishedAt: input.publishedAt,
    });
  },
} as const;
