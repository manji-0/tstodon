import { findAccountByUsername } from "../account-store";
import { answerOutboundFollow } from "../outbound-follow";
import { acceptOutboundFollow, rejectOutboundFollow } from "../outbound-follow-store";
import type { InboxHandler, RemoteDelivery } from "./handler";

/** The remote actor answers a local account's `Follow` of it. */
export const receiveFollowAnswer: InboxHandler<RemoteDelivery<"Accept" | "Reject">> = ({
  env,
  identity,
  signer,
  activity,
  received,
}) =>
  answerOutboundFollow(
    {
      findAccountByUsername: (username) => findAccountByUsername(env.DB, username),
      acceptOutboundFollow: (answer) => acceptOutboundFollow(env.DB, answer),
      rejectOutboundFollow: (answer) => rejectOutboundFollow(env.DB, answer),
    },
    identity,
    signer,
    { kind: activity.kind, objectId: activity.object, object: received.object },
  );
