import { schemaResult } from "@tstodon/core";
import { z } from "zod";

/**
 * How an admin treats one remote actor. Mastodon lets admins limit
 * (`silence`) or suspend a remote account and mark its media sensitive; a
 * remote actor has no login to disable and no sign-up to approve.
 */
const RemoteActorStandingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("InGoodStanding") }),
  z.object({ kind: z.literal("Silenced") }),
  z.object({ kind: z.literal("Suspended") }),
]);

export type RemoteActorStanding = z.infer<typeof RemoteActorStandingSchema>;

const RemoteActorModerationSchema = z.object({
  standing: RemoteActorStandingSchema,
  sensitized: z.boolean(),
});

export type RemoteActorModeration = z.infer<typeof RemoteActorModerationSchema>;

/** Every transition an admin can ask for. */
export type RemoteActorModerationAction =
  | "silence"
  | "unsilence"
  | "suspend"
  | "unsuspend"
  | "sensitize"
  | "unsensitize";

const inGoodStanding: RemoteActorModeration = {
  standing: { kind: "InGoodStanding" },
  sensitized: false,
};

export const RemoteActorModeration = {
  schema: RemoteActorModerationSchema,
  parse: schemaResult(RemoteActorModerationSchema),
  inGoodStanding,
  /**
   * The state after an action. Silencing never lifts a suspension, and lifting
   * one standing leaves the other alone (`unsilence` does not undo a suspend).
   */
  apply: (
    current: RemoteActorModeration,
    action: RemoteActorModerationAction,
  ): RemoteActorModeration => {
    switch (action) {
      case "silence":
        return current.standing.kind === "Suspended"
          ? current
          : { ...current, standing: { kind: "Silenced" } };
      case "suspend":
        return { ...current, standing: { kind: "Suspended" } };
      case "unsilence":
        return current.standing.kind === "Silenced"
          ? { ...current, standing: { kind: "InGoodStanding" } }
          : current;
      case "unsuspend":
        return current.standing.kind === "Suspended"
          ? { ...current, standing: { kind: "InGoodStanding" } }
          : current;
      case "sensitize":
        return { ...current, sensitized: true };
      case "unsensitize":
        return { ...current, sensitized: false };
    }
  },
  /** Whether the state is the default, so a store keeps no row for it. */
  isDefault: (moderation: RemoteActorModeration): boolean =>
    moderation.standing.kind === "InGoodStanding" && !moderation.sensitized,
} as const;
