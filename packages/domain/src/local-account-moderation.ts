import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { AccountStanding } from "./account-standing";
import type { RemoteActorModerationAction } from "./remote-actor-moderation";

/** Mastodon's `disable`: the login is blocked while the profile stays. */
const LoginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Enabled") }),
  z.object({ kind: z.literal("Disabled") }),
]);

/**
 * A sign-up on a server that requires approval waits until an admin approves
 * it; rejecting it deletes the account, so there is no rejected state.
 */
const ApprovalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Pending") }),
  z.object({ kind: z.literal("Approved") }),
]);

/**
 * How an admin treats one local account. Standing, the sensitive-media mark,
 * login, and approval are independent: Mastodon lets an account be disabled
 * and silenced at once, or pending and sensitized.
 */
const schema = z.object({
  standing: AccountStanding.schema,
  sensitized: z.boolean(),
  login: LoginSchema,
  approval: ApprovalSchema,
});

export type LocalAccountModeration = z.infer<typeof schema>;

/**
 * Every transition an admin can ask for on a local account. Approving is one
 * way: nothing moves an account back to pending.
 */
export type LocalAccountModerationAction =
  | RemoteActorModerationAction
  | "disable"
  | "enable"
  | "approve";

const inGoodStanding: LocalAccountModeration = {
  standing: AccountStanding.inGoodStanding,
  sensitized: false,
  login: { kind: "Enabled" },
  approval: { kind: "Approved" },
};

export const LocalAccountModeration = {
  schema,
  parse: schemaResult(schema),
  inGoodStanding,
  /** A fresh sign-up held until an admin approves it. */
  awaitingApproval: {
    ...inGoodStanding,
    approval: { kind: "Pending" },
  } satisfies LocalAccountModeration,
  /** The state after an action; see `AccountStanding.apply` for the standing. */
  apply: (
    current: LocalAccountModeration,
    action: LocalAccountModerationAction,
  ): LocalAccountModeration => {
    switch (action) {
      case "sensitize":
        return { ...current, sensitized: true };
      case "unsensitize":
        return { ...current, sensitized: false };
      case "disable":
        return { ...current, login: { kind: "Disabled" } };
      case "enable":
        return { ...current, login: { kind: "Enabled" } };
      case "approve":
        return { ...current, approval: { kind: "Approved" } };
      default:
        return { ...current, standing: AccountStanding.apply(current.standing, action) };
    }
  },
  /** The same transition on a remote actor, which has no login or sign-up to act on. */
  remoteCounterpart: (
    action: LocalAccountModerationAction,
  ): RemoteActorModerationAction | undefined => {
    switch (action) {
      case "disable":
      case "enable":
      case "approve":
        return undefined;
      default:
        return action;
    }
  },
  /** A suspended account and a disabled login may not sign in, post, or run jobs. */
  isBarred: (moderation: LocalAccountModeration): boolean =>
    moderation.standing.kind === "Suspended" || moderation.login.kind === "Disabled",
} as const;
