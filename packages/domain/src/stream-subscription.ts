import { unitKind } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { AccountId } from "./account-id";
import type { StreamChannel, StreamChannelError } from "./stream-channel";

/**
 * Who a streaming socket belongs to. Public and hashtag streams are open to
 * anonymous sockets, as `GET /api/v1/timelines/public` and the tag timeline
 * are; the others need the account.
 */
const StreamViewerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Account"), accountId: AccountId.schema }),
  unitKind("Anonymous"),
]);

export type StreamViewer = z.infer<typeof StreamViewerSchema>;

/**
 * What a token's scopes let a socket stream, as Mastodon's streaming server
 * reads them: `statuses` (`read` or `read:statuses`) opens `user`, `list`,
 * and `direct`; `notifications` (`read` or `read:notifications`) opens
 * `user:notification` and lets `user` carry notifications. Kept as two
 * flags, not the scopes, so the socket attachment stays small.
 */
const StreamAccessSchema = z.object({
  statuses: z.boolean(),
  notifications: z.boolean(),
});

export type StreamAccess = z.infer<typeof StreamAccessSchema>;

/** Why a socket may not subscribe to a stream. */
export type StreamRefusal =
  | StreamChannelError
  | Readonly<{ kind: "NeedsAccount" }>
  | Readonly<{ kind: "InsufficientScope" }>
  | Readonly<{ kind: "NotListOwner" }>
  | Readonly<{ kind: "SocketFull" }>
  | Readonly<{ kind: "HubFull" }>
  | Readonly<{ kind: "Unavailable" }>;

type ListChannel = Extract<StreamChannel, { kind: "List" }>;

/**
 * A subscription the viewer's token allows: granted outright, or a list
 * stream that is granted once the account is shown to own the list.
 */
export type StreamSubscription =
  | Readonly<{ kind: "Granted"; channel: StreamChannel }>
  | Readonly<{ kind: "NeedsListOwner"; channel: ListChannel; accountId: AccountId }>;

const needsAccount = (viewer: StreamViewer, allowed: boolean): Result<AccountId, StreamRefusal> => {
  if (viewer.kind === "Anonymous") {
    return err({ kind: "NeedsAccount" });
  }
  return allowed ? ok(viewer.accountId) : err({ kind: "InsufficientScope" });
};

export const StreamSubscription = {
  viewerSchema: StreamViewerSchema,
  accessSchema: StreamAccessSchema,
  /**
   * May this viewer subscribe? `user*` and `direct` are the account's own, a
   * list only its owner's, and each needs the scope of its stream. Public and
   * hashtag streams need no token, so no scope either.
   */
  authorize: (
    viewer: StreamViewer,
    access: StreamAccess,
    channel: StreamChannel,
  ): Result<StreamSubscription, StreamRefusal> => {
    switch (channel.kind) {
      case "Public":
      case "Hashtag":
        return ok({ kind: "Granted", channel });
      case "User":
      case "Direct":
        return needsAccount(viewer, access.statuses).map((): StreamSubscription => ({
          kind: "Granted",
          channel,
        }));
      case "UserNotification":
        return needsAccount(viewer, access.notifications).map((): StreamSubscription => ({
          kind: "Granted",
          channel,
        }));
      case "List":
        return needsAccount(viewer, access.statuses).map((accountId): StreamSubscription => ({
          kind: "NeedsListOwner",
          channel,
          accountId,
        }));
    }
  },
} as const;
