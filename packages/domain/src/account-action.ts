import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import type { RemoteActorModerationAction } from "./remote-actor-moderation";

/** Mastodon's `POST /api/v1/admin/accounts/:id/action` types. */
const schema = z.union([
  z.literal("none"),
  z.literal("sensitive"),
  z.literal("disable"),
  z.literal("silence"),
  z.literal("suspend"),
]);

export type AccountActionType = z.infer<typeof schema>;

/** What an action type does to a remote actor. */
export type RemoteAccountActionEffect =
  | Readonly<{ kind: "Nothing" }>
  | Readonly<{ kind: "Moderate"; action: RemoteActorModerationAction }>
  | Readonly<{ kind: "NotApplicable" }>;

/**
 * A remote actor has no login to `disable`, which Mastodon's remote accounts
 * do not take either.
 */
const REMOTE_EFFECT: Readonly<Record<AccountActionType, RemoteAccountActionEffect>> = {
  none: { kind: "Nothing" },
  sensitive: { kind: "Moderate", action: "sensitize" },
  silence: { kind: "Moderate", action: "silence" },
  suspend: { kind: "Moderate", action: "suspend" },
  disable: { kind: "NotApplicable" },
};

export const AccountActionType = {
  schema,
  parse: schemaResult(schema),
  remoteEffect: (type: AccountActionType): RemoteAccountActionEffect => REMOTE_EFFECT[type],
} as const;
