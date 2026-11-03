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

/**
 * Who a streaming socket belongs to. Public and hashtag streams are open to
 * anonymous sockets, as `GET /api/v1/timelines/public` and the tag timeline
 * are; the others need the account.
 */
export const StreamViewerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Account"), accountId: AccountId.schema }),
  unitKind("Anonymous"),
]);

export type StreamViewer = z.infer<typeof StreamViewerSchema>;

/** A socket's owner and the streams it is subscribed to, kept on the socket across hibernation. */
export const SocketStateSchema = z.object({
  viewer: StreamViewerSchema,
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
  | Readonly<{ kind: "NotListOwner" }>
  | Readonly<{ kind: "Unavailable" }>;

/** May this viewer subscribe? `user*` is the account's own; a list only its owner's. */
export const authorizeStreamChannel = async (
  env: Env,
  viewer: StreamViewer,
  channel: StreamChannelValue,
): Promise<Result<StreamChannelValue, StreamRefusal>> => {
  switch (channel.kind) {
    case "Public":
    case "Hashtag":
      return ok(channel);
    case "User":
    case "UserNotification":
      return viewer.kind === "Account" ? ok(channel) : err({ kind: "NeedsAccount" });
    case "List": {
      if (viewer.kind === "Anonymous") {
        return err({ kind: "NeedsAccount" });
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
): Readonly<{ error: string; status: 400 | 401 | 503 }> => {
  switch (refusal.kind) {
    case "UnknownStream":
      return { error: "Unknown stream type", status: 400 };
    case "MissingTag":
      return { error: "Missing tag name parameter", status: 400 };
    case "MissingList":
      return { error: "Missing list name parameter", status: 400 };
    case "NeedsAccount":
      return { error: "Missing access token", status: 401 };
    case "NotListOwner":
      return { error: "Not authorized to stream this list", status: 401 };
    case "Unavailable":
      return { error: "Stream unavailable", status: 503 };
  }
};

/** Parse and authorize a stream as a client names it. */
export const requestStreamChannel = async (
  env: Env,
  viewer: StreamViewer,
  input: Readonly<{ stream: string; tag?: string | undefined; list?: string | undefined }>,
): Promise<Result<StreamChannelValue, StreamRefusal>> => {
  const channel = StreamChannel.fromWire(input);
  if (channel.isErr()) {
    return err(channel.error);
  }
  return authorizeStreamChannel(env, viewer, channel.value);
};
