import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { AccountStanding, type AccountStandingAction } from "./account-standing";

/**
 * How an admin treats one remote actor. Mastodon lets admins limit
 * (`silence`) or suspend a remote account and mark its media sensitive; a
 * remote actor has no login to disable and no sign-up to approve.
 */
const RemoteActorModerationSchema = z.object({
  standing: AccountStanding.schema,
  sensitized: z.boolean(),
});

export type RemoteActorModeration = z.infer<typeof RemoteActorModerationSchema>;

/** Every transition an admin can ask for. */
export type RemoteActorModerationAction = AccountStandingAction | "sensitize" | "unsensitize";

const inGoodStanding: RemoteActorModeration = {
  standing: AccountStanding.inGoodStanding,
  sensitized: false,
};

export const RemoteActorModeration = {
  schema: RemoteActorModerationSchema,
  parse: schemaResult(RemoteActorModerationSchema),
  inGoodStanding,
  /** The state after an action; see `AccountStanding.apply` for the standing. */
  apply: (
    current: RemoteActorModeration,
    action: RemoteActorModerationAction,
  ): RemoteActorModeration => {
    switch (action) {
      case "sensitize":
        return { ...current, sensitized: true };
      case "unsensitize":
        return { ...current, sensitized: false };
      default:
        return { ...current, standing: AccountStanding.apply(current.standing, action) };
    }
  },
  /** Whether the state is the default, so a store keeps no row for it. */
  isDefault: (moderation: RemoteActorModeration): boolean =>
    moderation.standing.kind === "InGoodStanding" && !moderation.sensitized,
} as const;
