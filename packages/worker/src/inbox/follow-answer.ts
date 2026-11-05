import { err, ok } from "neverthrow";
import { outboundFollowAnswer } from "../outbound-follow";
import { acceptOutboundFollow, rejectOutboundFollow } from "../outbound-follow-store";
import type { InboxHandler, RemoteDelivery } from "./handler";

/** The remote actor answers a local account's `Follow` of it. */
export const receiveFollowAnswer: InboxHandler<RemoteDelivery<"Accept" | "Reject">> = async ({
  env,
  identity,
  signer,
  activity,
  received,
}) => {
  const answer = await outboundFollowAnswer(
    env.DB,
    identity,
    signer,
    activity.object,
    received.object,
  );
  if (answer.isErr()) {
    return err(answer.error);
  }
  const answered =
    activity.kind === "Accept"
      ? await acceptOutboundFollow(env.DB, answer.value)
      : await rejectOutboundFollow(env.DB, answer.value);
  return answered.isErr() ? err(answered.error) : ok(undefined);
};
