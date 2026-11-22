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

/**
 * The silence and the suspension the instance domain blocks hold on one
 * actor (Mastodon's `silenced_at` / `suspended_at` that `BlockDomainService`
 * or `ProcessAccountService#create_account` set).
 */
export type DomainBlockLimits = Readonly<{ silenced: boolean; suspended: boolean }>;

/** A remote actor's moderation as an admin reads it. */
export type RemoteActorAdminFlags = Readonly<{
  silenced: boolean;
  suspended: boolean;
  sensitized: boolean;
}>;

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
  /**
   * What an admin sees, as Mastodon's separate `silenced?`, `suspended?` and
   * `sensitized?`: a silence or a suspension the admin made, or one an
   * instance domain block holds on the actor. The two are not ranked: an
   * actor can be both.
   */
  adminFlags: (own: RemoteActorModeration, domain: DomainBlockLimits): RemoteActorAdminFlags => ({
    silenced: own.standing.kind === "Silenced" || domain.silenced,
    suspended: own.standing.kind === "Suspended" || domain.suspended,
    sensitized: own.sensitized,
  }),
  /** Whether the state is the default, so a store keeps no row for it. */
  isDefault: (moderation: RemoteActorModeration): boolean =>
    moderation.standing.kind === "InGoodStanding" && !moderation.sensitized,
} as const;
