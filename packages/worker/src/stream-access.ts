import { schemaResult, unitKind } from "@tstodon/core";
import {
  AccountId,
  StreamChannel,
  type StreamChannelError,
  type StreamChannelValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findListForAccount } from "./list-store";
import { covers } from "./oauth-scope";

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

/** An anonymous socket holds no token, so no scope. */
export const NO_STREAM_ACCESS: StreamAccess = { statuses: false, notifications: false };

export const streamAccess = (scopes: ReadonlyArray<string>): StreamAccess => ({
  statuses: covers(scopes, "read:statuses"),
  notifications: covers(scopes, "read:notifications"),
});

/** A socket's owner, scopes, and subscribed streams, kept on the socket across hibernation. */
const SocketStateSchema = z.object({
  viewer: StreamViewerSchema,
  access: StreamAccessSchema,
  channels: z.array(StreamChannel.schema),
});

export type SocketState = z.infer<typeof SocketStateSchema>;

export const parseSocketState = schemaResult(SocketStateSchema);

/** The hub every anonymous socket shares; account ids never take this name. */
export const ANONYMOUS_HUB = "anonymous";

/** The `StreamHub` a viewer's sockets live in: one per account, one for anonymous sockets. */
export const hubName = (viewer: StreamViewer): string =>
  viewer.kind === "Account" ? viewer.accountId : ANONYMOUS_HUB;

/** Why a socket may not subscribe to a stream. */
export type StreamRefusal =
  | StreamChannelError
  | Readonly<{ kind: "NeedsAccount" }>
  | Readonly<{ kind: "InsufficientScope" }>
  | Readonly<{ kind: "NotListOwner" }>
  | Readonly<{ kind: "SocketFull" }>
  | Readonly<{ kind: "HubFull" }>
  | Readonly<{ kind: "Unavailable" }>;

/**
 * May this viewer subscribe? `user*` and `direct` are the account's own, a
 * list only its owner's, and each needs the scope of its stream. Public and
 * hashtag streams need no token, so no scope either.
 */
const authorizeStreamChannel = async (
  env: Env,
  viewer: StreamViewer,
  access: StreamAccess,
  channel: StreamChannelValue,
): Promise<Result<StreamChannelValue, StreamRefusal>> => {
  switch (channel.kind) {
    case "Public":
    case "Hashtag":
      return ok(channel);
    case "User":
    case "Direct":
      if (viewer.kind === "Anonymous") {
        return err({ kind: "NeedsAccount" });
      }
      return access.statuses ? ok(channel) : err({ kind: "InsufficientScope" });
    case "UserNotification":
      if (viewer.kind === "Anonymous") {
        return err({ kind: "NeedsAccount" });
      }
      return access.notifications ? ok(channel) : err({ kind: "InsufficientScope" });
    case "List": {
      if (viewer.kind === "Anonymous") {
        return err({ kind: "NeedsAccount" });
      }
      if (!access.statuses) {
        return err({ kind: "InsufficientScope" });
      }
      const list = await findListForAccount(env.DB, viewer.accountId, channel.listId);
      if (list.isErr()) {
        return err({ kind: "Unavailable" });
      }
      return list.value ? ok(channel) : err({ kind: "NotListOwner" });
    }
  }
};

/** Mastodon's streaming error: the message and the HTTP status it stands for. */
export const streamRefusalError = (
  refusal: StreamRefusal,
): Readonly<{ error: string; status: 400 | 401 | 429 | 503 }> => {
  switch (refusal.kind) {
    case "UnknownStream":
      return { error: "Unknown stream type", status: 400 };
    case "MissingTag":
      return { error: "Missing tag name parameter", status: 400 };
    case "InvalidTag":
      return { error: "Invalid tag name parameter", status: 400 };
    case "MissingList":
      return { error: "Missing list name parameter", status: 400 };
    case "InvalidList":
    case "NotListOwner":
      return { error: "Not authorized to stream this list", status: 401 };
    case "SocketFull":
      return { error: "Too many streams on this connection", status: 429 };
    case "HubFull":
      return { error: "Too many distinct streams open for this viewer", status: 429 };
    case "NeedsAccount":
      return { error: "Missing access token", status: 401 };
    case "InsufficientScope":
      return { error: "Access token does not have the required scopes", status: 401 };
    case "Unavailable":
      return { error: "Stream unavailable", status: 503 };
  }
};

/** Parse and authorize a stream as a client names it. */
export const requestStreamChannel = async (
  env: Env,
  viewer: StreamViewer,
  access: StreamAccess,
  input: Readonly<{ stream: string; tag?: string | undefined; list?: string | undefined }>,
): Promise<Result<StreamChannelValue, StreamRefusal>> => {
  const channel = StreamChannel.fromWire(input);
  if (channel.isErr()) {
    return err(channel.error);
  }
  return authorizeStreamChannel(env, viewer, access, channel.value);
};
