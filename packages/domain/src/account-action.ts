import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import type { LocalAccountModerationAction } from "./local-account-moderation";
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

/** What an action type does to a local account. */
export type LocalAccountActionEffect =
  | Readonly<{ kind: "Nothing" }>
  | Readonly<{ kind: "Moderate"; action: LocalAccountModerationAction }>;

const LOCAL_EFFECT: Readonly<Record<AccountActionType, LocalAccountActionEffect>> = {
  none: { kind: "Nothing" },
  sensitive: { kind: "Moderate", action: "sensitize" },
  silence: { kind: "Moderate", action: "silence" },
  suspend: { kind: "Moderate", action: "suspend" },
  disable: { kind: "Moderate", action: "disable" },
};

export const AccountActionType = {
  schema,
  parse: schemaResult(schema),
  localEffect: (type: AccountActionType): LocalAccountActionEffect => LOCAL_EFFECT[type],
  remoteEffect: (type: AccountActionType): RemoteAccountActionEffect => REMOTE_EFFECT[type],
} as const;
