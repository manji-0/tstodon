import { schemaResult } from "@tstodon/core";
import {
  AccountId,
  type AccountIdValue,
  StreamChannel,
  type StreamAccess,
  type StreamChannelValue,
  type StreamRefusal,
  StreamSubscription,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findListForAccount } from "./list-store";
import { covers } from "./oauth-scope";

export const streamAccess = (scopes: ReadonlyArray<string>): StreamAccess => ({
  statuses: covers(scopes, "read:statuses"),
  notifications: covers(scopes, "read:notifications"),
});

/**
 * A socket's account, scopes, and subscribed streams, kept on the socket
 * across hibernation. The account also names the socket's `StreamHub`.
 */
const SocketStateSchema = z.object({
  accountId: AccountId.schema,
  access: StreamSubscription.accessSchema,
  channels: z.array(StreamChannel.schema),
});

export type SocketState = z.infer<typeof SocketStateSchema>;

export const parseSocketState = schemaResult(SocketStateSchema);

/** A list stream is granted once the account is shown to own the list. */
const authorizeStreamChannel = async (
  env: Env,
  accountId: AccountIdValue,
  access: StreamAccess,
  channel: StreamChannelValue,
): Promise<Result<StreamChannelValue, StreamRefusal>> => {
  const subscription = StreamSubscription.authorize(access, channel);
  if (subscription.isErr()) {
    return err(subscription.error);
  }
  if (subscription.value.kind === "Granted") {
    return ok(subscription.value.channel);
  }
  const listChannel = subscription.value.channel;
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
    case "InsufficientScope":
      return { error: "Access token does not have the required scopes", status: 401 };
    case "Unavailable":
      return { error: "Stream unavailable", status: 503 };
  }
};

/** Parse and authorize a stream as a client names it. */
export const requestStreamChannel = async (
  env: Env,
  accountId: AccountIdValue,
  access: StreamAccess,
  input: Readonly<{ stream: string; tag?: string | undefined; list?: string | undefined }>,
): Promise<Result<StreamChannelValue, StreamRefusal>> => {
  const channel = StreamChannel.fromWire(input);
  if (channel.isErr()) {
    return err(channel.error);
  }
  return authorizeStreamChannel(env, accountId, access, channel.value);
};
