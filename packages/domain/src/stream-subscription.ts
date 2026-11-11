import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { StreamChannel, StreamChannelError } from "./stream-channel";

/**
 * What a token's scopes let a socket stream, as Mastodon's streaming server
 * (4.5 and later) reads them: `statuses` (`read` or `read:statuses`) opens
 * every stream but `user:notification`, public and hashtag ones included;
 * `notifications` (`read` or `read:notifications`) opens `user:notification`
 * and lets `user` carry notifications. Kept as two flags, not the scopes, so
 * the socket attachment stays small.
 */
const StreamAccessSchema = z.object({
  statuses: z.boolean(),
  notifications: z.boolean(),
});

export type StreamAccess = z.infer<typeof StreamAccessSchema>;

/** Why a socket may not subscribe to a stream. */
export type StreamRefusal =
  | StreamChannelError
  | Readonly<{ kind: "InsufficientScope" }>
  | Readonly<{ kind: "NotListOwner" }>
  | Readonly<{ kind: "SocketFull" }>
  | Readonly<{ kind: "HubFull" }>
  | Readonly<{ kind: "Unavailable" }>;

type ListChannel = Extract<StreamChannel, { kind: "List" }>;

/**
 * A subscription the socket's token allows: granted outright, or a list
 * stream that is granted once the socket's account is shown to own the list.
 */
export type StreamSubscription =
  | Readonly<{ kind: "Granted"; channel: StreamChannel }>
  | Readonly<{ kind: "NeedsListOwner"; channel: ListChannel }>;

const needsScope = (allowed: boolean): Result<void, StreamRefusal> =>
  allowed ? ok(undefined) : err({ kind: "InsufficientScope" });

export const StreamSubscription = {
  accessSchema: StreamAccessSchema,
  /**
   * May a socket with this access subscribe? Every socket belongs to an
   * account (the streaming route refuses one without a token), each stream
   * needs its scope, and a list stream is only its owner's.
   */
  authorize: (
    access: StreamAccess,
    channel: StreamChannel,
  ): Result<StreamSubscription, StreamRefusal> => {
    switch (channel.kind) {
      case "Public":
      case "Hashtag":
      case "User":
      case "Direct":
        return needsScope(access.statuses).map((): StreamSubscription => ({
          kind: "Granted",
          channel,
        }));
      case "UserNotification":
        return needsScope(access.notifications).map((): StreamSubscription => ({
          kind: "Granted",
          channel,
        }));
      case "List":
        return needsScope(access.statuses).map((): StreamSubscription => ({
          kind: "NeedsListOwner",
          channel,
        }));
    }
  },
} as const;
