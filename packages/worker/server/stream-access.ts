import { schemaResult } from "@tstodon/core";
import {
  StreamChannel,
  type StreamAccess,
  type StreamChannelValue,
  type StreamRefusal,
  StreamSubscription,
  type StreamViewer,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findListForAccount } from "./list-store";
import { covers } from "./oauth-scope";

/** An anonymous socket holds no token, so no scope. */
export const NO_STREAM_ACCESS: StreamAccess = { statuses: false, notifications: false };

export const streamAccess = (scopes: ReadonlyArray<string>): StreamAccess => ({
  statuses: covers(scopes, "read:statuses"),
  notifications: covers(scopes, "read:notifications"),
});

/** A socket's owner, scopes, and subscribed streams, kept on the socket across hibernation. */
const SocketStateSchema = z.object({
  viewer: StreamSubscription.viewerSchema,
  access: StreamSubscription.accessSchema,
  channels: z.array(StreamChannel.schema),
});

export type SocketState = z.infer<typeof SocketStateSchema>;

export const parseSocketState = schemaResult(SocketStateSchema);

/** The hub every anonymous socket shares; account ids never take this name. */
export const ANONYMOUS_HUB = "anonymous";

/** The `StreamHub` a viewer's sockets live in: one per account, one for anonymous sockets. */
export const hubName = (viewer: StreamViewer): string =>
  viewer.kind === "Account" ? viewer.accountId : ANONYMOUS_HUB;

/** A list stream is granted once the account is shown to own the list. */
const authorizeStreamChannel = async (
  env: Env,
  viewer: StreamViewer,
  access: StreamAccess,
  channel: StreamChannelValue,
): Promise<Result<StreamChannelValue, StreamRefusal>> => {
  const subscription = StreamSubscription.authorize(viewer, access, channel);
  if (subscription.isErr()) {
    return err(subscription.error);
  }
  if (subscription.value.kind === "Granted") {
    return ok(subscription.value.channel);
  }
  const { accountId, channel: listChannel } = subscription.value;
  const list = await findListForAccount(env.DB, accountId, listChannel.listId);
  if (list.isErr()) {
    return err({ kind: "Unavailable" });
  }
  return list.value ? ok(listChannel) : err({ kind: "NotListOwner" });
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
